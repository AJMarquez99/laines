import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadContainer } from '../lib/container.js';
import { getLane, readLanes, updateLanes } from '../lib/lanes-store.js';
import { dropRequests, putRequest, requestId } from '../lib/lanes-state.js';
import { assertLaneDir, removeLaneDir } from '../lib/containment.js';
import { untrackedEntries } from '../lib/lane-files.js';
import { forceFingerprint, holdingLines, siblingHoldings, unpushedWork } from '../lib/lane-git.js';
import { hookStates, listHooks } from '../lib/hooks.js';
import { dryRunHooks, hookBoardEntries, hookError, runEvent, runSummary, unapprovedWarnings } from '../lib/hook-events.js';
import { appendAudit } from '../lib/audit.js';
import { withLock } from '../lib/lock.js';
import { writeAiBase } from '../lib/ai-tree.js';
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

const keptMessage = (name, kept) =>
  `Lane ${name} is kept (${kept.reason}). A human must run \`laines release ${name}\` before it can be torn down.`;

// One locked board update for a hook run: its unapproved-hook notes, plus the caller's request and line.
const recordHookRun = (ctx, deps, run, name, finish) =>
  updateLanes(ctx, deps, (s) => {
    const ts = deps.now();
    const board = hookBoardEntries(run, { lane: name, now: ts });
    const { state, text } = finish(board.requests.reduce(putRequest, s), ts);
    return { state, result: null, activity: [...board.activity, { ts, lane: name, text }] };
  });

// The refusal the CLI throws for unpushed work; the dry run carries the same text for callers that must not re-run a real teardown.
export const unpushedRefusal = (laneDir, problems, isRepo, holdings) =>
  [
    `Refusing to remove ${laneDir}:`,
    ...problems.map((p) => `  - ${p}`),
    ...holdingLines(holdings),
    isRepo
      ? `Push the work, or save it first: git -C ${laneDir} bundle create <file> --all --not --remotes`
      : `Copy anything you need out of ${laneDir} first.`,
    'Nothing has been archived or deleted. Use --force only after confirming this work can be lost.',
  ].join('\n');

const changedMessage = (laneDir) =>
  `The unpushed work in ${laneDir} changed after you were shown it. Nothing was torn down; ask again to see the current state.`;

// Human-only (deny rules in agent settings): the lane must always be named.
export async function runTeardown(opts, deps) {
  if (!opts.lane) throw new InvalidInputError('Name the lane to tear down: `laines teardown <lane>`.');
  const ctx = loadContainer(opts, deps);
  const name = opts.lane;
  const before = readLanes(ctx);
  const lane = getLane(before, name);
  if (!lane) throw new InvalidInputError(`No lane named ${name}. See \`laines list --all\`.`);
  // A malformed hooks.lock.json fails here, before anything is touched.
  hookStates(ctx.paths);
  if (lane.kept) {
    throw new BlockedError(keptMessage(name, lane.kept));
  }
  const closed = lane.state === 'closed';
  const cleanupId = requestId('cleanup-incomplete', name);
  const cleanupPending = before.requests.some((q) => q.id === cleanupId);
  if (closed && !opts.removeDir && !cleanupPending) {
    throw new InvalidInputError(`Lane ${name} is already closed. Pass --remove-dir to delete its clone.`);
  }
  const laneDir = join(ctx.root, lane.repos[0].path);
  const real = assertLaneDir(ctx.root, laneDir, lane.repos[0].path);
  const isRepo = Boolean(real) && existsSync(join(real, '.git'));
  // A directory that is not a repository cannot be proven safe to delete: refuse unless --force.
  const unverifiable = { dirty: [], stashes: 0, unpushed: 0, refs: [], noUpstream: null, problems: ['not a git repository: unpushed work cannot be verified'] };
  let checks = null;
  if (opts.removeDir && real) checks = isRepo ? unpushedWork(deps, real) : unverifiable;
  if (checks?.refs.length) checks.holdings = siblingHoldings(deps, ctx, name, checks.refs);
  const fingerprint = checks && isRepo ? forceFingerprint(deps, real, checks) : null;
  // `expect` is set only by the MCP typed confirmation: what the human saw must still be what is there.
  if (opts.expect !== undefined && opts.expect !== fingerprint) {
    throw new BlockedError(changedMessage(laneDir));
  }
  const risky = Boolean(checks && checks.problems.length);
  const blocked = risky && !opts.force;
  const warnings = checks?.noUpstream ? [`branch ${checks.noUpstream} has no upstream`] : [];
  // A first teardown runs pre-teardown (when the clone exists) and post-teardown. Tearing down a
  // closed lane again re-runs only a post-teardown that failed last time.
  const runPre = !closed && Boolean(real);
  const runPost = !closed || cleanupPending;
  const viaMcp = risky && Boolean(opts.force) && opts.expect !== undefined;

  if (opts.dryRun) {
    const hooks = [...(runPre ? [dryRunHooks(ctx, 'pre-teardown')] : []), ...(runPost ? [dryRunHooks(ctx, 'post-teardown')] : [])];
    return { dryRun: true, lane: name, path: laneDir, blocked, removedDir: Boolean(opts.removeDir && real), forced: risky && Boolean(opts.force), checks, fingerprint, warnings, hooks, refusal: blocked ? unpushedRefusal(laneDir, checks.problems, isRepo, checks.holdings) : null };
  }
  if (blocked) {
    throw new BlockedError(unpushedRefusal(laneDir, checks.problems, isRepo, checks.holdings));
  }

  // Spec §10.3 step 4: pre-teardown runs after the safety checks and before anything is touched.
  let pre = null;
  if (runPre) {
    // Narrow the window for a `keep` landing during the checks: the hook may have side effects.
    // The under-lock re-check below still decides; the lock is never held while a hook runs.
    const fresh = getLane(readLanes(ctx), name);
    if (fresh?.kept) throw new BlockedError(keptMessage(name, fresh.kept));
    pre = await runEvent(ctx, deps, { event: 'pre-teardown', name, lane, cwd: real });
    if (pre.outcome !== 'ok') {
      await recordHookRun(ctx, deps, pre, name, (state, ts) => ({
        state: pre.outcome === 'failed'
          ? state
          : putRequest(state, {
            ts,
            lane: name,
            kind: 'teardown-blocked',
            text: `teardown stopped — pre-teardown: ${runSummary(pre)}`,
            command: `${pre.outcome === 'refused' ? 'laines hooks approve && ' : ''}laines teardown ${name}${opts.removeDir ? ' --remove-dir' : ''}`,
          }),
        text: `teardown aborted, nothing touched — pre-teardown: ${runSummary(pre)}`,
      }));
      throw hookError(pre, 'Teardown aborted: nothing was archived or deleted.');
    }
    warnings.push(...unapprovedWarnings(pre));
  } else if (!closed && listHooks(ctx.paths.hooks, 'pre-teardown').length) {
    warnings.push(`pre-teardown skipped: ${laneDir} does not exist`);
  }

  const now = deps.now();
  let archivedTo = null;
  let contextDeleted = false;
  if (!closed) {
    // Re-checked under the lock: a `keep` that landed during the git checks must win, and the
    // archive/delete happen only once the record is known to be closable.
    await updateLanes(ctx, deps, (s) => {
      const board = pre ? hookBoardEntries(pre, { lane: name, now }) : { activity: [], requests: [] };
      const state = board.requests.reduce(putRequest, s);
      const l = getLane(state, name);
      if (!l) throw new InvalidInputError(`Lane ${name} no longer exists.`);
      if (l.kept) throw new BlockedError(keptMessage(name, l.kept));
      // A pre-teardown hook runs user code between the first check and here: re-verify what the human saw.
      if (opts.expect !== undefined && isRepo && forceFingerprint(deps, real, unpushedWork(deps, real)) !== opts.expect) {
        throw new BlockedError(changedMessage(laneDir));
      }
      if (real) {
        archivedTo = archivePlans(ctx, deps, real, name);
        contextDeleted = deleteContext(deps, real);
      }
      l.state = 'closed';
      l.status = 'closed';
      l.blocked = null;
      l.closed = now;
      l.updated = now;
      state.requests = state.requests.filter((q) => q.lane !== name);
      const note = archivedTo ? `plans archived to ${archivedTo}` : 'no plans to archive';
      const via = viaMcp ? `; torn down over MCP; forced after a typed confirmation: ${checks.problems.join('; ')}` : '';
      return { state, result: null, activity: [...board.activity, { ts: now, lane: name, text: `lane torn down; ${note}${via}` }] };
    });
  } else if (opts.removeDir && real) {
    // Second phase of a two-step teardown: anything written since the close is archived too.
    archivedTo = archivePlans(ctx, deps, real, name);
    contextDeleted = deleteContext(deps, real);
  }
  if (!closed) {
    // A closed lane no longer syncs; a lane re-created under this name starts from its own clone.
    try {
      await withLock(ctx.paths.lock, () => writeAiBase(ctx.paths, name, null));
    } catch (err) {
      warnings.push(`.ai/ sync base for ${name} not removed: ${String(err.message).split('\n')[0]}`);
    }
  }
  const removedDir = opts.removeDir ? removeLaneDir(ctx.root, laneDir, lane.repos[0].path) : false;
  if (closed && opts.removeDir) {
    const text = removedDir ? `clone removed${archivedTo ? `; plans archived to ${archivedTo}` : ''}` : 'no clone left to remove';
    await updateLanes(ctx, deps, (state) => ({ state, result: null, activity: [{ ts: deps.now(), lane: name, text }] }));
  }

  // Spec §10.3 step 7: post-teardown runs in the container; a failure leaves a request, never an error.
  let post = null;
  if (runPost) {
    post = await runEvent(ctx, deps, { event: 'post-teardown', name, lane, cwd: ctx.root });
    const ok = post.outcome === 'ok';
    const retry = `${post.outcome === 'refused' ? 'laines hooks approve && ' : ''}laines teardown ${name}`;
    warnings.push(...unapprovedWarnings(post));
    if (!ok) warnings.push(`cleanup incomplete: ${runSummary(post)}. Fix it, then run \`${retry}\` to retry.`);
    if (!ok || post.results.length || cleanupPending) {
      await recordHookRun(ctx, deps, post, name, (state, ts) => ({
        state: ok
          ? dropRequests(state, (q) => q.id === cleanupId)
          : putRequest(state, { ts, lane: name, kind: 'cleanup-incomplete', text: `cleanup incomplete: ${runSummary(post)}`, command: retry }),
        text: ok ? `post-teardown: ${runSummary(post)}` : `cleanup incomplete: ${runSummary(post)}`,
      }));
    }
  }
  const forced = risky && Boolean(opts.force);
  appendAudit(
    ctx.paths.audit,
    { ts: now, action: 'teardown', container: ctx.id, lane: name, removedDir, forced, ...(viaMcp ? { forcedVia: 'mcp-typed-confirmation', discarded: checks.problems } : {}), hooks: { pre: pre?.outcome ?? null, post: post?.outcome ?? null } },
    { warn: deps.warn },
  );
  return { dryRun: false, lane: name, path: laneDir, archivedTo, contextDeleted, removedDir, forced, checks, warnings, hooks: [pre, post].filter(Boolean) };
}
