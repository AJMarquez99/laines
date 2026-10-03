import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadContainer } from '../lib/container.js';
import { getLane, readLanes, updateLanes } from '../lib/lanes-store.js';
import { assertLaneDir, removeLaneDir } from '../lib/containment.js';
import { writeLaneFiles } from '../lib/lane-files.js';
import { buildBrief } from '../lib/brief.js';
import { gitOut, gitOutAsync } from '../lib/git.js';
import { lanePorts } from '../lib/ports.js';
import { LANE_NAME, laneId } from '../lib/ids.js';
import { shellQuote } from '../lib/paths.js';
import { appendAudit } from '../lib/audit.js';
import { BlockedError, InvalidInputError } from '../lib/errors.js';
import { dropRequests, putRequest, requestId } from '../lib/lanes-state.js';
import { currentChecksums, hookStates } from '../lib/hooks.js';
import {
  HISTORY_CAP, dryRunHooks, hookBoardEntries, hookError, lockRequest, lockSuggested,
  runEvent, runSummary, setupFailedNext, setupFailedRequest, unapprovedWarnings,
} from '../lib/hook-events.js';


// An explicit `<lanePrefix><N>` name claims lane number N, so the name and the ports agree. Only a
// canonical number counts: `lane_003` or `lane_0` is a custom name.
function explicitNumber(ctx, name) {
  const prefix = ctx.config.lanePrefix;
  if (name === undefined || !name.startsWith(prefix)) return null;
  const m = /^[1-9]\d*$/.exec(name.slice(prefix.length));
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
  if (opts.name !== undefined && (!LANE_NAME.test(opts.name) || opts.name === '__proto__')) {
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
  // A malformed hooks.lock.json fails here, before anything is cloned or reserved.
  hookStates(ctx.paths);

  if (opts.dryRun) {
    const p = planLane(ctx, readLanes(ctx), opts);
    return { dryRun: true, lane: p.name, id: laneId(ctx.id, p.name), number: p.number, path: p.laneDir, branch, ports: p.ports, remote: repo.remote, warnings: [], hooks: dryRunHooks(ctx, 'post-create') };
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
    await gitOutAsync(deps, ['clone', '--origin', 'origin', '--', repo.remote, plan.laneDir], ctx.root);
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
  // Spec §10.2 steps 5–6: post-create runs once the lane is on disk, outside the lock. A failed hook
  // keeps the lane as setup-failed so it can be fixed and refreshed.
  const record = { number: plan.number, repos: [{ name: repoName, path: plan.name, branch }], ports: plan.ports };
  const run = await runEvent(ctx, deps, { event: 'post-create', name: plan.name, lane: record, cwd: plan.laneDir });
  const ok = run.outcome === 'ok';
  const checksums = ok ? currentChecksums(ctx.paths) : null;
  let suggestLock = false;

  const lane = await updateLanes(ctx, deps, (s) => {
    const ts = deps.now();
    const board = hookBoardEntries(run, { lane: plan.name, now: ts });
    let state = board.requests.reduce(putRequest, s);
    // Mutating l is safe: putRequest keeps state.lanes the same object as in s.
    const l = getLane(state, plan.name);
    l.updated = ts;
    if (ok) {
      l.status = 'idle';
      state.hookHistory = [...state.hookHistory, { ts, checksums }].slice(-HISTORY_CAP);
      suggestLock = lockSuggested(state, ctx.config, checksums);
      // The suggestion tracks the current set: a changed set withdraws it.
      state = suggestLock
        ? putRequest(state, lockRequest(ctx.config, ts))
        : dropRequests(state, (q) => q.id === requestId('hooks-lock', null));
    } else {
      l.state = 'setup-failed';
      l.status = 'setup-failed';
      state = putRequest(state, setupFailedRequest(run, plan.name, ts));
    }
    const text = ok ? `lane created on branch ${branch}` : `lane created on branch ${branch}; setup failed — post-create: ${runSummary(run)}`;
    return { state, result: l, activity: [...board.activity, { ts, lane: plan.name, text }] };
  });
  appendAudit(ctx.paths.audit, { ts: deps.now(), action: 'create', container: ctx.id, lane: plan.name, branch, hooks: run.outcome }, { warn: deps.warn });
  if (!ok) throw hookError(run, setupFailedNext(run, plan.name));

  const { stableAfter } = ctx.config.hooks;
  return {
    dryRun: false,
    lane: plan.name,
    id: laneId(ctx.id, plan.name),
    number: plan.number,
    path: plan.laneDir,
    branch,
    ports: plan.ports,
    files: files.written,
    warnings: [...files.skipped.map((s) => `${s.file} not written: ${s.reason}`), ...unapprovedWarnings(run)],
    hooks: run,
    brief: buildBrief(ctx, plan.name, lane),
    next: [
      `cd ${shellQuote(plan.laneDir)} && ${ctx.config.agentCmd}`,
      `or hand \`laines brief ${plan.name}\` to a subagent`,
      ...(suggestLock ? [`hooks have been unchanged across the last ${stableAfter} creates: a human can lock them with \`laines hooks approve --lock\``] : []),
    ],
  };
}
