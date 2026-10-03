import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { laneFrom, loadContainer } from '../lib/container.js';
import { getLane, readLanes, updateLanes } from '../lib/lanes-store.js';
import { dropRequests, putRequest, requestId, spinUpState } from '../lib/lanes-state.js';
import { assertLaneDir } from '../lib/containment.js';
import { writeLaneFiles } from '../lib/lane-files.js';
import { denyRules, mergeDenyRules } from '../lib/agent-files.js';
import { hookStates } from '../lib/hooks.js';
import {
  dryRunHooks, hookBoardEntries, hookError, runEvent, runSummary, setupFailedNext, setupFailedRequest, unapprovedWarnings,
} from '../lib/hook-events.js';
import { appendAudit } from '../lib/audit.js';
import { InvalidInputError, MalformedConfigError } from '../lib/errors.js';

// Records one post-create run on the board, the lane and the audit log; returns whether it succeeded.
async function recordRun(ctx, deps, run, name, branch) {
  const ok = run.outcome === 'ok';
  await updateLanes(ctx, deps, (s) => {
    const ts = deps.now();
    const board = hookBoardEntries(run, { lane: name, now: ts });
    let state = board.requests.reduce(putRequest, s);
    const l = getLane(state, name);
    if (!l || l.state === 'closed') throw new InvalidInputError(`Lane ${name} was torn down while it was being refreshed.`);
    l.repos[0].branch = branch;
    l.updated = ts;
    if (ok) {
      if (l.state === 'setup-failed' || l.status === 'spinning up') {
        l.state = 'active';
        l.status = 'idle';
      }
      state = dropRequests(state, (q) => q.id === requestId('setup-failed', name));
    } else {
      l.state = 'setup-failed';
      l.status = 'setup-failed';
      state = putRequest(state, setupFailedRequest(run, name, ts));
    }
    const text = ok ? `lane refreshed (post-create: ${runSummary(run)})` : `refresh failed — post-create: ${runSummary(run)}`;
    return { state, result: null, activity: [...board.activity, { ts, lane: name, text }] };
  });
  appendAudit(ctx.paths.audit, { ts: deps.now(), action: 'refresh', container: ctx.id, lane: name, hooks: run.outcome }, { warn: deps.warn });
  return ok;
}

// Rewrites the lane-local files and .laines.env from scratch, then re-runs post-create. The way to
// recover a setup-failed lane, and to pick up changed hooks or templates.
export async function runRefresh(opts, deps) {
  const ctx = loadContainer(opts, deps);
  const name = laneFrom(opts, deps, ctx);
  const lane = getLane(readLanes(ctx), name);
  if (!lane) throw new InvalidInputError(`No lane named ${name}. See \`laines list\`.`);
  // A malformed hooks.lock.json fails here, before anything is written.
  hookStates(ctx.paths);
  if (lane.state === 'closed') throw new InvalidInputError(`Lane ${name} is closed. Create a new lane instead.`);
  if (spinUpState(lane, ctx.config, deps.now()) === 'running') {
    throw new InvalidInputError(`Lane ${name} is still being created (spinning up since ${lane.updated}). Wait for \`laines create\` to finish; \`laines doctor\` reports it as interrupted once the create window has passed.`);
  }
  const laneDir = join(ctx.root, lane.repos[0].path);
  const real = assertLaneDir(ctx.root, laneDir, lane.repos[0].path);
  if (!real || !existsSync(join(real, '.git'))) {
    throw new InvalidInputError(`${laneDir} is missing or not a git clone. Tear the lane down (\`laines teardown ${name} --remove-dir --force\`) and create it again.`);
  }
  if (opts.dryRun) return { dryRun: true, lane: name, path: laneDir, hooks: dryRunHooks(ctx, 'post-create') };
  // Containers made before a new human-only command existed get its deny rules here. A malformed
  // container settings file is the container's problem (doctor reports it), not this lane's.
  const warnings = [];
  try {
    mergeDenyRules(ctx.paths.claudeSettings, denyRules());
  } catch (err) {
    if (!(err instanceof MalformedConfigError)) throw err;
    warnings.push(`container deny rules not checked: ${ctx.paths.claudeSettings} is malformed. Fix it, then run \`laines refresh ${name}\` again.`);
  }

  // The board and LANE_BRANCH follow the branch the clone is on now; a detached HEAD keeps the old one.
  const head = deps.git(['branch', '--show-current'], { cwd: real });
  const branch = head.status === 0 && head.stdout.trim() ? head.stdout.trim() : lane.repos[0].branch;
  const record = { ...lane, repos: [{ ...lane.repos[0], branch }] };
  const event = { event: 'post-create', name, lane: record, cwd: real };
  // A refusal must not touch the lane: .laines.env keeps what the approved hooks appended to it.
  if (dryRunHooks(ctx, 'post-create').refused) {
    const run = await runEvent(ctx, deps, event);
    await recordRun(ctx, deps, run, name, branch);
    throw hookError(run, setupFailedNext(run, name));
  }
  const files = writeLaneFiles(ctx, deps, { name, number: lane.number, laneDir, branch, ports: lane.ports });
  const run = await runEvent(ctx, deps, event);
  const ok = await recordRun(ctx, deps, run, name, branch);
  if (!ok) throw hookError(run, setupFailedNext(run, name));
  return {
    dryRun: false,
    lane: name,
    path: laneDir,
    branch,
    files: files.written,
    warnings: [...warnings, ...files.skipped.map((f) => `${f.file} not written: ${f.reason}`), ...unapprovedWarnings(run)],
    hooks: run,
  };
}
