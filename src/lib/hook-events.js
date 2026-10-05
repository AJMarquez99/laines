import { join } from 'node:path';
import { appendAudit } from './audit.js';
import { hookDiff, hookStates, isExecutable } from './hooks.js';
import { laneVars } from './lane-files.js';
import { EXIT_CODES, HookError } from './errors.js';

export const HISTORY_CAP = 100;

const short = (sum) => sum.slice(0, 'sha256:'.length + 12);

export function laneHookVars(ctx, name, lane) {
  return laneVars({
    lane: name,
    number: lane.number,
    containerId: ctx.id,
    laneDir: join(ctx.root, lane.repos[0].path),
    containerDir: ctx.root,
    ports: lane.ports,
    branch: lane.repos[0].branch,
    compose: lane.compose,
    adopted: lane.adopted,
  });
}

const START_ERRORS = {
  ENOENT: 'the interpreter on its #! line was not found',
  ENOEXEC: 'it has no #! line',
};

const brief = (h) => ({ hook: h.rel, state: h.state, checksum: h.checksum });

// Spec §8.3–8.4: run one event's hooks in order under the hook policy. Returns data only; the
// caller records it through updateLanes. Must never be called while the container lock is held.
export async function runEvent(ctx, deps, { event, name, lane, cwd }) {
  const { policy, timeoutSec } = ctx.config.hooks;
  const run = { event, policy, timeoutSec, hooks: [], unapproved: [], results: [], outcome: 'ok', error: null };
  let hooks;
  try {
    ({ hooks } = hookStates(ctx.paths, [event]));
  } catch (err) {
    return { ...run, outcome: 'failed', error: err.message.split('\n')[0] };
  }
  run.hooks = hooks.map(brief);
  const unapproved = policy === 'open' ? [] : hooks.filter((h) => h.state !== 'approved');
  run.unapproved = unapproved.map(brief);
  if (policy === 'approve' && unapproved.length) {
    return { ...run, outcome: 'refused', diffs: unapproved.map((h) => ({ hook: h.rel, state: h.state, diff: hookDiff(deps, ctx.paths, h) })) };
  }
  // The warning itself reaches the user through the command's `warnings` (unapprovedWarnings).
  for (const h of unapproved) {
    appendAudit(
      ctx.paths.audit,
      { ts: deps.now(), action: 'hook-unapproved', container: ctx.id, lane: name, hook: h.rel, state: h.state, checksum: h.checksum, policy },
      { warn: deps.warn },
    );
  }
  const vars = { ...laneHookVars(ctx, name, lane), LAINES_HOOK: event, LAINES_DRY_RUN: '0' };
  for (const h of hooks) {
    if (!isExecutable(h.path)) {
      run.results.push({ hook: h.rel, status: null, signal: null, timedOut: false, durationMs: 0, untrusted: false, output: `${h.path} is not executable: run chmod +x on it.` });
      return { ...run, outcome: 'failed' };
    }
    const r = await deps.runHook({ file: h.path, cwd, vars, timeoutMs: timeoutSec * 1000 });
    // The kernel's reasons a file cannot start: these come from laines, not from the hook.
    const reason = r.error && r.status === null && !r.timedOut ? START_ERRORS[r.error.code] : undefined;
    if (reason) {
      run.results.push({ hook: h.rel, status: null, signal: null, timedOut: false, durationMs: r.durationMs, untrusted: false, output: `${h.path} could not start: ${reason}.` });
      return { ...run, outcome: 'failed' };
    }
    run.results.push({
      hook: h.rel,
      status: r.status,
      signal: r.signal ?? null,
      timedOut: r.timedOut,
      durationMs: r.durationMs,
      untrusted: true,
      output: r.output || (r.error ? r.error.message : ''),
    });
    if (r.status === 3) return { ...run, outcome: 'blocked' };
    if (r.status !== 0) return { ...run, outcome: 'failed' };
  }
  return run;
}

export function dryRunHooks(ctx, event) {
  const { policy } = ctx.config.hooks;
  const { hooks } = hookStates(ctx.paths, [event]);
  const refused = policy === 'approve' && hooks.some((h) => h.state !== 'approved');
  return { event, policy, wouldRun: !refused && hooks.length > 0, refused, hooks: hooks.map(brief) };
}

export function runSummary(run) {
  if (run.error) return `could not check hooks: ${run.error}`;
  if (run.outcome === 'refused') {
    return `refused under policy approve: ${run.unapproved.map((u) => `${u.hook} (${u.state})`).join(', ')} not approved`;
  }
  if (run.outcome === 'ok') return run.results.length ? `${run.results.length} hook(s) ran` : 'no hooks';
  const last = run.results.at(-1);
  const why = last.timedOut
    ? `timed out after ${run.timeoutSec}s`
    : last.signal
      ? `was stopped by ${last.signal}`
      : last.status === null
        ? 'could not run'
        : `exited ${last.status}`;
  return `${last.hook} ${why}${run.outcome === 'blocked' ? ' (needs a human)' : ''}`;
}

const ranUnapproved = (run) => {
  const ran = new Set(run.results.filter((r) => r.untrusted).map((r) => r.hook));
  return run.unapproved.filter((u) => ran.has(u.hook));
};

// Spec §8.4 (notify): a board note with the new checksum, and one container-wide request to approve.
export function hookBoardEntries(run, { lane, now }) {
  const unapprovedRan = run.outcome === 'refused' ? run.unapproved : ranUnapproved(run);
  if (!unapprovedRan.length) return { activity: [], requests: [] };
  const list = unapprovedRan.map((u) => `${u.hook} (${u.state}, ${short(u.checksum)})`).join(', ');
  const text = run.outcome === 'refused'
    ? `${run.event} refused under policy approve: ${list}`
    : `unapproved hook(s) ran under policy ${run.policy}: ${list}`;
  return {
    activity: [{ ts: now, lane, text }],
    requests: [{
      ts: now,
      lane: null,
      kind: 'hooks-changed',
      text: 'hooks changed since the last approval: review them with `laines hooks status`',
      command: 'laines hooks approve',
    }],
  };
}

export const unapprovedWarnings = (run) => {
  const unapprovedRan = run.outcome === 'refused' ? [] : ranUnapproved(run);
  return unapprovedRan.map((u) => `hook ${u.hook} is ${u.state} and ran unapproved (policy ${run.policy}); review it with \`laines hooks status\``);
};

export function hookError(run, next) {
  const lines = [`${run.event}: ${runSummary(run)}.`];
  if (run.outcome === 'refused') {
    for (const d of run.diffs) lines.push('', `--- ${d.hook} (${d.state}) ---`, d.diff.trimEnd() || '(no diff)');
  } else if (run.results.length) {
    const last = run.results.at(-1);
    if (last.untrusted) lines.push("Hook output (untrusted: printed by the project's hook script):");
    lines.push(last.output.trimEnd() || '(no output)');
  }
  lines.push('', next);
  return new HookError(lines.join('\n'), run.outcome === 'failed' ? EXIT_CODES.GENERIC : EXIT_CODES.BLOCKED, run);
}

export function setupFailedRequest(run, lane, ts) {
  const refresh = `laines refresh ${lane}`;
  return {
    ts,
    lane,
    kind: 'setup-failed',
    text: `post-create: ${runSummary(run)}`,
    command: run.outcome === 'refused' ? `laines hooks approve && ${refresh}` : refresh,
  };
}

export function setupFailedNext(run, lane) {
  const head = `Lane ${lane} is kept on disk and marked setup-failed.`;
  return run.outcome === 'refused'
    ? `${head} A human must review the hooks (\`laines hooks status\`) and approve them (\`laines hooks approve\`); then run \`laines refresh ${lane}\`.`
    : `${head} Fix the hook or what it needs, then run \`laines refresh ${lane}\`.`;
}

export const lockRequest = (config, ts) => ({
  ts,
  lane: null,
  kind: 'hooks-lock',
  text: `hooks unchanged across the last ${config.hooks.stableAfter} successful creates: consider locking them`,
  command: 'laines hooks approve --lock',
});

const sameSet = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

// Spec §8.4: suggest (never apply) a lock once the hook set has been unchanged across the last
// stableAfter successful creates.
export function lockSuggested(state, config, current) {
  const { policy, stableAfter } = config.hooks;
  if (policy === 'approve' || !Object.keys(current).length) return false;
  const recent = state.hookHistory.slice(-stableAfter);
  return recent.length === stableAfter && recent.every((h) => sameSet(h.checksums, current));
}
