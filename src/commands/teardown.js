import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadContainer } from '../lib/container.js';
import { readLanes, updateLanes } from '../lib/lanes-store.js';
import { assertLaneDir, removeLaneDir } from '../lib/containment.js';
import { untrackedEntries } from '../lib/lane-files.js';
import { unpushedWork } from '../lib/lane-git.js';
import { appendAudit } from '../lib/audit.js';
import { BlockedError, InvalidInputError } from '../lib/errors.js';

function archivePlans(ctx, deps, laneDir, name) {
  const entries = untrackedEntries(deps, laneDir, '.ai/plans');
  if (!entries.length) return null;
  const base = `${deps.now().slice(0, 10)}_${name}`;
  let dirName = base;
  for (let i = 2; existsSync(join(ctx.paths.ai, 'archive', dirName)); i += 1) dirName = `${base}-${i}`;
  const dest = join(ctx.paths.ai, 'archive', dirName, 'plans');
  mkdirSync(dest, { recursive: true });
  for (const entry of entries) renameSync(join(laneDir, '.ai', 'plans', entry), join(dest, entry));
  return `.ai/archive/${dirName}`;
}

function deleteContext(deps, laneDir) {
  const entries = untrackedEntries(deps, laneDir, '.ai/context');
  for (const entry of entries) rmSync(join(laneDir, '.ai', 'context', entry), { recursive: true, force: true });
  return entries.length > 0;
}

// Human-only (deny rules in agent settings): the lane must always be named.
export async function runTeardown(opts, deps) {
  if (!opts.lane) throw new InvalidInputError('Name the lane to tear down: `laines teardown <lane>`.');
  const ctx = loadContainer(opts, deps);
  const name = opts.lane;
  const lane = readLanes(ctx).lanes[name];
  if (!lane) throw new InvalidInputError(`No lane named ${name}. See \`laines list --all\`.`);
  if (lane.kept) {
    throw new BlockedError(`Lane ${name} is kept (${lane.kept.reason}). A human must run \`laines release ${name}\` before it can be torn down.`);
  }
  if (lane.state === 'closed' && !opts.removeDir) {
    throw new InvalidInputError(`Lane ${name} is already closed. Pass --remove-dir to delete its clone.`);
  }
  const laneDir = join(ctx.root, lane.repos[0].path);
  const real = assertLaneDir(ctx.root, laneDir, lane.repos[0].path);
  const isRepo = Boolean(real) && existsSync(join(real, '.git'));
  const checks = opts.removeDir && isRepo ? unpushedWork(deps, real) : null;
  const risky = Boolean(checks && checks.problems.length);
  const blocked = risky && !opts.force;
  const warnings = checks?.noUpstream ? [`branch ${checks.noUpstream} has no upstream`] : [];

  if (opts.dryRun) {
    return { dryRun: true, lane: name, path: laneDir, blocked, removeDir: Boolean(opts.removeDir && real), forced: risky && Boolean(opts.force), checks, warnings };
  }
  if (blocked) {
    throw new BlockedError([
      `Refusing to remove ${laneDir}:`,
      ...checks.problems.map((p) => `  - ${p}`),
      `Push the work, or save it first: git -C ${laneDir} bundle create <file> --all --not --remotes`,
      'Nothing has been archived or deleted. Use --force only after confirming this work can be lost.',
    ].join('\n'));
  }

  // M3: run the pre-teardown hook here; a failure aborts with nothing touched.
  const open = lane.state !== 'closed' && Boolean(real);
  const archivedTo = open ? archivePlans(ctx, deps, real, name) : null;
  const contextDeleted = open ? deleteContext(deps, real) : false;
  const now = deps.now();
  if (lane.state !== 'closed') {
    await updateLanes(ctx, deps, (state) => {
      const l = state.lanes[name];
      l.state = 'closed';
      l.status = 'closed';
      l.blocked = null;
      l.closed = now;
      l.updated = now;
      state.requests = state.requests.filter((q) => q.lane !== name);
      const note = archivedTo ? `plans archived to ${archivedTo}` : 'no plans to archive';
      return { state, result: null, activity: [{ ts: now, lane: name, text: `lane torn down; ${note}` }] };
    });
  }
  const removedDir = opts.removeDir ? removeLaneDir(ctx.root, laneDir, lane.repos[0].path) : false;
  // M3: run the post-teardown hook here.
  const forced = risky && Boolean(opts.force);
  appendAudit(ctx.paths.audit, { ts: now, action: 'teardown', container: ctx.id, lane: name, removedDir, forced }, { warn: deps.warn });
  return { dryRun: false, lane: name, path: laneDir, archivedTo, contextDeleted, removedDir, forced, checks, warnings };
}
