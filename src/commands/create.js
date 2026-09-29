import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadContainer } from '../lib/container.js';
import { readLanes, updateLanes } from '../lib/lanes-store.js';
import { assertLaneDir, removeLaneDir } from '../lib/containment.js';
import { writeLaneFiles } from '../lib/lane-files.js';
import { buildBrief } from '../lib/brief.js';
import { gitOut } from '../lib/git.js';
import { lanePorts } from '../lib/ports.js';
import { laneId } from '../lib/ids.js';
import { appendAudit } from '../lib/audit.js';
import { BlockedError, InvalidInputError } from '../lib/errors.js';

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function planLane(ctx, state, opts) {
  const used = new Set(Object.values(state.lanes).filter((l) => l.state !== 'closed').map((l) => l.number));
  let number = 1;
  while (used.has(number)) number += 1;
  if (number > ctx.config.maxLanes) {
    throw new BlockedError(`All ${ctx.config.maxLanes} lanes are in use. Tear one down, or raise maxLanes in .laines/config.json.`);
  }
  const name = opts.name ?? `${ctx.config.lanePrefix}${number}`;
  const existing = state.lanes[name];
  if (existing && existing.state !== 'closed') throw new InvalidInputError(`Lane ${name} already exists.`);
  const laneDir = join(ctx.root, name);
  assertLaneDir(ctx.root, laneDir, name);
  if (existsSync(laneDir)) throw new InvalidInputError(`${laneDir} already exists. Remove it or pick another name.`);
  return { name, number, laneDir, ports: lanePorts(ctx.portRange, number, ctx.config.ports.stride) };
}

function validate(ctx, deps, opts, branch) {
  if (opts.name !== undefined && !NAME.test(opts.name)) {
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

  const abandon = async (why) => {
    removeLaneDir(ctx.root, plan.laneDir, plan.name);
    await updateLanes(ctx, deps, (state) => {
      delete state.lanes[plan.name];
      return { state, result: null, activity: [{ ts: deps.now(), lane: plan.name, text: `lane creation failed: ${why}` }] };
    });
  };

  const busy = await deps.busyPorts(plan.ports);
  if (busy.length) {
    await abandon('ports in use');
    throw new InvalidInputError(`Ports already in use: ${busy.join(', ')}. Stop what is using them (check with \`lsof -i :${busy[0]}\`) and retry.`);
  }

  let files;
  try {
    gitOut(deps, ['clone', '--', repo.remote, plan.laneDir], ctx.root);
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
    const l = state.lanes[plan.name];
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
    next: [`cd ${plan.laneDir} && ${ctx.config.agentCmd}`, `or hand \`laines brief ${plan.name}\` to a subagent`],
  };
}
