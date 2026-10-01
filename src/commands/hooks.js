import { loadContainer } from '../lib/container.js';
import { readLanes, updateLanes } from '../lib/lanes-store.js';
import { dropRequests } from '../lib/lanes-state.js';
import { approveHooks, hookDiff, hookStates, isExecutable } from '../lib/hooks.js';
import { lockSuggested } from '../lib/hook-events.js';
import { saveConfig } from '../config.js';
import { appendAudit } from '../lib/audit.js';
import { InvalidInputError } from '../lib/errors.js';

const POLICIES = ['approve', 'notify', 'open'];

// Mutates ctx.config too, so the board rendered afterwards shows the new policy.
function setPolicy(ctx, policy) {
  ctx.config = { ...ctx.config, hooks: { ...ctx.config.hooks, policy } };
  saveConfig(ctx.paths.config, ctx.config);
}

export async function runHooksStatus(opts, deps) {
  const ctx = loadContainer(opts, deps);
  const { hooks, removed } = hookStates(ctx.paths);
  const current = Object.fromEntries(hooks.map((h) => [h.rel, h.checksum]));
  return {
    policy: ctx.config.hooks.policy,
    hooks: hooks.map((h) => ({
      hook: h.rel,
      event: h.event,
      state: h.state,
      checksum: h.checksum,
      approved: h.approved,
      executable: isExecutable(h.path),
      ...(h.state === 'approved' ? {} : { diff: hookDiff(deps, ctx.paths, h) }),
    })),
    removed,
    lockSuggested: lockSuggested(readLanes(ctx), ctx.config, current),
  };
}

// Human-only (deny rules in agent settings).
export async function runHooksApprove(opts, deps) {
  const ctx = loadContainer(opts, deps);
  if (opts.dryRun) {
    const { hooks, removed } = hookStates(ctx.paths);
    return { dryRun: true, approve: hooks.filter((h) => h.state !== 'approved').map((h) => ({ hook: h.rel, state: h.state, checksum: h.checksum })), removed, lock: Boolean(opts.lock) };
  }
  const { approved, removed } = approveHooks(ctx.paths);
  if (opts.lock) setPolicy(ctx, 'approve');
  const now = deps.now();
  const list = approved.map((h) => h.rel).join(', ') || 'none';
  await updateLanes(ctx, deps, (s) => ({
    state: dropRequests(s, (q) => q.kind === 'hooks-changed' || (opts.lock && q.kind === 'hooks-lock')),
    result: null,
    activity: [{ ts: now, lane: null, text: `hooks approved: ${list}${opts.lock ? '; hook policy set to approve' : ''}` }],
  }));
  appendAudit(
    ctx.paths.audit,
    { ts: now, action: 'hooks-approve', container: ctx.id, hooks: Object.fromEntries(approved.map((h) => [h.rel, h.checksum])), lock: Boolean(opts.lock) },
    { warn: deps.warn },
  );
  return { dryRun: false, approved: approved.map((h) => ({ hook: h.rel, checksum: h.checksum, was: h.state })), removed, policy: ctx.config.hooks.policy };
}

// Human-only (deny rules in agent settings).
export async function runHooksPolicy(opts, deps) {
  const to = opts.policy;
  if (!POLICIES.includes(to)) throw new InvalidInputError(`Hook policy must be one of: ${POLICIES.join(', ')} (got "${to}").`);
  const ctx = loadContainer(opts, deps);
  const from = ctx.config.hooks.policy;
  const changed = from !== to;
  if (opts.dryRun || !changed) return { dryRun: Boolean(opts.dryRun), from, to, changed };
  setPolicy(ctx, to);
  const now = deps.now();
  await updateLanes(ctx, deps, (s) => ({
    // Any policy change settles the lock suggestion: `approve` fulfils it, others decline it.
    state: dropRequests(s, (q) => q.kind === 'hooks-lock'),
    result: null,
    activity: [{ ts: now, lane: null, text: `hook policy changed: ${from} → ${to}` }],
  }));
  appendAudit(ctx.paths.audit, { ts: now, action: 'hooks-policy', container: ctx.id, from, to }, { warn: deps.warn });
  return { dryRun: false, from, to, changed };
}
