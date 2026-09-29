import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadContainer } from '../lib/container.js';
import { getLane, readLanes, updateLanes } from '../lib/lanes-store.js';
import { assertLaneDir, removeLaneDir } from '../lib/containment.js';
import { writeLaneFiles } from '../lib/lane-files.js';
import { buildBrief } from '../lib/brief.js';
import { gitOut } from '../lib/git.js';
import { lanePorts } from '../lib/ports.js';
import { laneId } from '../lib/ids.js';
import { shellQuote } from '../lib/paths.js';
import { appendAudit } from '../lib/audit.js';
import { BlockedError, InvalidInputError } from '../lib/errors.js';

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

// An explicit `<lanePrefix><N>` name claims lane number N, so the name and the ports agree.
function explicitNumber(ctx, name) {
  const prefix = ctx.config.lanePrefix;
  if (name === undefined || !name.startsWith(prefix)) return null;
  const m = /^\d+$/.exec(name.slice(prefix.length));
  return m ? Number(m[0]) : null;
}

function planLane(ctx, state, opts) {
  const { maxLanes } = ctx.config;
  const used = new Set(Object.values(state.lanes).filter((l) => l.state !== 'closed').map((l) => l.number));
  let number = explicitNumber(ctx, opts.name);
  if (number !== null) {
    if (number < 1 || number > maxLanes) throw new InvalidInputError(`Lane ${opts.name}: lane numbers run from 1 to maxLanes (${maxLanes}).`);
    if (used.has(number)) throw new InvalidInputError(`Lane number ${number} is already in use. See \`laines list\`.`);
  } else {
    number = 1;
    while (used.has(number)) number += 1;
    if (number > maxLanes) {
      throw new BlockedError(`All ${maxLanes} lanes are in use. Tear one down, or raise maxLanes in .laines/config.json.`);
    }
  }
  const name = opts.name ?? `${ctx.config.lanePrefix}${number}`;
  const existing = getLane(state, name);
  if (existing && existing.state !== 'closed') throw new InvalidInputError(`Lane ${name} already exists.`);
  const laneDir = join(ctx.root, name);
  assertLaneDir(ctx.root, laneDir, name);
  if (existsSync(laneDir)) throw new InvalidInputError(`${laneDir} already exists. Remove it or pick another name.`);
  return { name, number, laneDir, ports: lanePorts(ctx.portRange, number, ctx.config.ports.stride) };
}

function validate(ctx, deps, opts, branch) {
  // `__proto__` would set the prototype of state.lanes rather than add a lane.
  if (opts.name !== undefined && (!NAME.test(opts.name) || opts.name === '__proto__')) {
    throw new InvalidInputError(`Invalid lane name "${opts.name}": use lowercase letters, digits, "_" and "-", start with a letter or digit, max 32 characters.`);
  }
  if (String(branch).startsWith('-') || deps.git(['check-ref-format', '--branch', branch], { cwd: ctx.root }).status !== 0) {
    throw new InvalidInputError(`Invalid branch name "${branch}".`);
  }
}

export async function runCreate(opts, deps) {
  const ctx = loadContainer(opts, deps);
  const [repoName, repo] = Object.entries(ctx.config.repos)[0];
  const branch = opts.branch ?? repo.defaultBranch;
  validate(ctx, deps, opts, branch);

  if (opts.dryRun) {
    const p = planLane(ctx, readLanes(ctx), opts);
    return { dryRun: true, lane: p.name, id: laneId(ctx.id, p.name), number: p.number, path: p.laneDir, branch, ports: p.ports, remote: repo.remote, warnings: [] };
  }

  // Reserve under the lock so concurrent creates never pick the same number; clone outside it.
  const now = deps.now();
  const plan = await updateLanes(ctx, deps, (state) => {
    const p = planLane(ctx, state, opts);
    state.lanes[p.name] = {
      number: p.number,
      repos: [{ name: repoName, path: p.name, branch }],
      ports: p.ports,
      state: 'active',
      status: 'spinning up',
      task: null,
      blocked: null,
      kept: null,
      created: now,
      updated: now,
      closed: null,
    };
    return { state, result: p, activity: [{ ts: now, lane: p.name, text: `lane reserved (ports ${p.ports[0]}–${p.ports[1]}); cloning ${branch}` }] };
  });

  // Best effort: each step runs even if another fails, and never throws, so the caller always
  // rethrows the error that caused the rollback.
  const abandon = async (why) => {
    const failures = [];
    let registered = false;
    try {
      removeLaneDir(ctx.root, plan.laneDir, plan.name);
    } catch (err) {
      failures.push(`removing ${plan.laneDir}: ${err.message}`);
    }
    try {
      await updateLanes(ctx, deps, (state) => {
        delete state.lanes[plan.name];
        return { state, result: null, activity: [{ ts: deps.now(), lane: plan.name, text: `lane creation failed: ${why}` }] };
      });
    } catch (err) {
      registered = true;
      failures.push(`unregistering the lane: ${err.message}`);
    }
    if (failures.length) {
      // Teardown finds only a registered lane; an unregistered leftover directory is removed by hand.
      const fix = registered ? `run \`laines teardown ${plan.name} --remove-dir --force\`` : `remove ${plan.laneDir} by hand`;
      deps.warn(`Cleanup after the failed create of lane ${plan.name} was incomplete (${failures.join('; ')}). Once the cause is fixed, ${fix}.`);
    }
  };

  const busy = await deps.busyPorts(plan.ports);
  if (busy.length) {
    await abandon('ports in use');
    throw new InvalidInputError(`Ports already in use: ${busy.join(', ')}. Stop what is using them (check with \`lsof -i :${busy[0]}\`) and retry.`);
  }

  let files;
  try {
    gitOut(deps, ['clone', '--origin', 'origin', '--', repo.remote, plan.laneDir], ctx.root);
    const current = gitOut(deps, ['branch', '--show-current'], plan.laneDir).trim();
    if (current !== branch) {
      const onRemote = deps.git(['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd: plan.laneDir }).status === 0;
      gitOut(deps, onRemote ? ['checkout', '-q', '-b', branch, '--track', `origin/${branch}`] : ['checkout', '-q', '-b', branch], plan.laneDir);
    }
    files = writeLaneFiles(ctx, deps, { ...plan, branch });
  } catch (err) {
    await abandon(String(err.message).split('\n')[0]);
    throw err;
  }
  // M3: run the post-create hook here.

  const lane = await updateLanes(ctx, deps, (state) => {
    const l = getLane(state, plan.name);
    l.status = 'idle';
    l.updated = deps.now();
    return { state, result: l, activity: [{ ts: deps.now(), lane: plan.name, text: `lane created on branch ${branch}` }] };
  });
  appendAudit(ctx.paths.audit, { ts: deps.now(), action: 'create', container: ctx.id, lane: plan.name, branch }, { warn: deps.warn });

  return {
    dryRun: false,
    lane: plan.name,
    id: laneId(ctx.id, plan.name),
    number: plan.number,
    path: plan.laneDir,
    branch,
    ports: plan.ports,
    files: files.written,
    warnings: files.skipped.map((s) => `${s.file} not written: ${s.reason}`),
    brief: buildBrief(ctx, plan.name, lane),
    next: [`cd ${shellQuote(plan.laneDir)} && ${ctx.config.agentCmd}`, `or hand \`laines brief ${plan.name}\` to a subagent`],
  };
}
