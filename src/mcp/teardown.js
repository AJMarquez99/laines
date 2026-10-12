import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { invoke } from '../commands/registry.js';
import { loadContainer } from '../lib/container.js';
import { getLane, readLanes, updateLanes } from '../lib/lanes-store.js';
import { putRequest } from '../lib/lanes-state.js';
import { untrackedEntries } from '../lib/lane-files.js';
import { changedSinceClose, holdingLines } from '../lib/lane-git.js';
import { BlockedError, InvalidInputError } from '../lib/errors.js';

export const CONFIRM_SCHEMA = {
  type: 'object',
  properties: { confirm: { type: 'boolean', title: 'Tear down this lane' } },
  required: ['confirm'],
};

// The open-lane form also offers to keep the clone (deleting it is the default); a human's tick, never an agent argument.
export const CONFIRM_WITH_CLONE_SCHEMA = {
  type: 'object',
  properties: { ...CONFIRM_SCHEMA.properties, keep_dir: { type: 'boolean', title: 'Keep the clone instead' } },
  required: ['confirm'],
};

export const TYPED_SCHEMA = (lane) => ({
  type: 'object',
  properties: { lane: { type: 'string', title: `Type ${lane} to discard this work` } },
  required: ['lane'],
});

export const notConfirmed = 'Not confirmed: nothing was torn down.';

export const declinedMessage = (lane) =>
  `Declined or no response — if you weren't prompted, run \`laines teardown ${lane}\` in your terminal.`;

// For a closed lane's leftover clone: what changed there after the lane closed (no board entry tracks it).
function closedChanges(ctx, deps, plan, opts) {
  const lane = getLane(readLanes(ctx), opts.lane);
  return lane.state === 'closed' && lane.closed && existsSync(plan.path) ? changedSinceClose(deps, plan.path, lane.closed) : null;
}

// Exactly what a forced teardown will lose, for the second (typed) form.
function discardMessage(ctx, deps, plan, opts) {
  const { checks } = plan;
  const late = closedChanges(ctx, deps, plan, opts);
  const note = (ref) => (late?.refs.some((r) => r.ref === ref) ? ' (changed after the lane closed)' : '');
  // A ref deleted since the dry run shows no subjects; the fingerprint refuses the run anyway.
  const subjects = (ref) => {
    const r = deps.git(['log', '--format=%s', '-n', '3', ref, '--not', '--remotes'], { cwd: plan.path });
    return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
  };
  const dirty = checks.dirty.slice(0, 10).map((f) => `  - ${f}`);
  if (checks.dirty.length > 10) dirty.push(`  - and ${checks.dirty.length - 10} more`);
  return [
    `This permanently discards work in lane ${opts.lane} (${plan.path}):`,
    ...checks.refs.flatMap((r) => [`- ${r.ref}: ${r.commits} commit(s) on no remote${note(r.ref)}`, ...subjects(r.ref).map((t) => `    ${t}`)]),
    ...(checks.dirty.length ? [`- ${checks.dirty.length} uncommitted change(s):`, ...dirty] : []),
    ...(checks.stashes ? [`- ${checks.stashes} stash entr${checks.stashes === 1 ? 'y' : 'ies'}`] : []),
    ...(checks.problems.length && !checks.refs.length && !checks.dirty.length && !checks.stashes ? checks.problems.map((p) => `- ${p}`) : []),
    ...holdingLines(checks.holdings),
    `Type the lane name (${opts.lane}) to delete it anyway. Anything else cancels.`,
  ].join('\n');
}

function confirmMessage(ctx, deps, plan, opts) {
  const lane = getLane(readLanes(ctx), opts.lane);
  const plans = existsSync(plan.path) ? untrackedEntries(deps, plan.path, '.ai/plans').length : 0;
  const tickable = !opts.keepDir && lane.state !== 'closed';
  const unpushed = plan.blocked
    ? [`present (unless you tick "Keep the clone instead", the next prompt asks you to type the lane name to discard it)`, ...plan.checks.problems.map((p) => `    ${p}`), ...holdingLines(plan.checks.holdings)].join('\n')
    : opts.keepDir ? 'not checked (the clone is kept)' : plan.checks === null ? 'not checked (no clone)' : 'none';
  const late = closedChanges(ctx, deps, plan, opts);
  const afterClose = late && (late.refs.length || late.dirty.length)
    ? [`- Refs changed after the lane closed (${lane.closed}): ${[...late.refs.map((r) => r.ref), ...(late.dirty.length ? [`${late.dirty.length} uncommitted file(s) present`] : [])].join(', ')}`]
    : [];
  const clone = plan.removedDir
    ? `deleted, after the unpushed-work checks${tickable ? '; tick "Keep the clone instead" to keep it (no checks then)' : ''}`
    : opts.keepDir ? 'kept (keep_dir)' : 'no clone to delete';
  const hooks = plan.hooks.flatMap((h) => h.hooks.map((x) => `${x.hook} (${x.state})`)).join(', ') || 'none';
  return [
    `Tear down lane ${opts.lane} of container ${ctx.id}?`,
    `- Branch: ${lane.repos[0].branch}`,
    `- Path: ${plan.path}`,
    `- Archived: ${plans} entr${plans === 1 ? 'y' : 'ies'} of .ai/plans/ move to the container's .ai/archive/; .ai/context/ is deleted`,
    `- Clone: ${clone}`,
    `- Unpushed work: ${unpushed}`,
    ...afterClose,
    ...plan.warnings.map((w) => `- Warning: ${w}`),
    `- Hooks that run: ${hooks}`,
    'A lane that looks finished may still be the base of stacked PRs or related work.',
  ].join('\n');
}

// Spec §9.3. `confirm` asks the human through elicitation; `auto` applies the CLI's checks only;
// `off` refuses (and the server does not register the tool). There is no force on this path.
export async function runTeardownMcp(opts, deps) {
  if (!opts.lane) throw new InvalidInputError('Name the lane to tear down.');
  const ctx = loadContainer(opts, deps);
  const mode = ctx.config.teardown.mcp;
  if (mode === 'off') {
    throw new BlockedError('Teardown over MCP is turned off for this container (teardown.mcp is "off"). A human can run `laines teardown <lane>` in a terminal.');
  }
  const args = { lane: opts.lane, keepDir: opts.keepDir, removeDir: opts.removeDir, container: opts.container };
  if (opts.dryRun || mode === 'auto') return invoke('teardown', { ...args, dryRun: opts.dryRun }, deps);

  // The dry run applies every check (capability, keep, closed, unpushed work) and touches nothing.
  const planFor = (keepDir) => invoke('teardown', { ...args, keepDir, dryRun: true }, deps);
  // Only unpushed work can be forced, and only when a human can be asked and the container is not locked.
  const forceable = (plan) => plan.blocked && existsSync(join(plan.path, '.git')) && ctx.config.teardown.mcpForce === 'confirm' && !ctx.config.locked && Boolean(deps.canElicit?.());
  let plan = await planFor(opts.keepDir);
  if (plan.blocked && !forceable(plan)) {
    // never re-run the real teardown without an accept
    throw new BlockedError(opts.keepDir ? plan.refusal : `${plan.refusal}\nTo close the lane and keep its clone instead, ask again with keep_dir.`);
  }
  const offerClone = !opts.keepDir && getLane(readLanes(ctx), opts.lane).state !== 'closed';
  const command = `laines teardown ${opts.lane}${opts.keepDir ? ' --keep-dir' : ''}`;
  if (!deps.canElicit?.()) {
    const ts = deps.now();
    await updateLanes(ctx, deps, (state) => ({
      state: putRequest(state, { ts, lane: opts.lane, kind: 'teardown-confirm', text: 'an agent asked to tear this lane down; its MCP client cannot ask you to confirm', command }),
      result: null,
      activity: [{ ts, lane: opts.lane, text: 'teardown requested over MCP: waiting for a human to confirm' }],
    }));
    throw new BlockedError(`This MCP client cannot ask a human to confirm a teardown. The request is on the board; a human completes it with \`${command}\`.`);
  }
  const message = confirmMessage(ctx, deps, plan, opts);
  let answer = null;
  try {
    answer = await deps.elicit(message, offerClone ? CONFIRM_WITH_CLONE_SCHEMA : CONFIRM_SCHEMA);
  } catch (error) {
    deps.warn?.(`teardown confirmation failed: ${error?.message ?? error}`); // a timeout or a client error is no answer
  }
  if (answer?.action !== 'accept' || answer.content?.confirm !== true) throw new BlockedError(declinedMessage(opts.lane));
  if (offerClone && answer.content.keep_dir === true) {
    // The human ticked "keep": re-plan without the clone's deletion (and so without its unpushed-work checks) before anything happens.
    opts = { ...opts, keepDir: true, removeDir: undefined };
    args.keepDir = true;
    args.removeDir = undefined; // the deprecated alias would contradict the tick
    plan = await planFor(true);
  }
  if (!plan.blocked) return invoke('teardown', args, deps);

  // The second form: the human types the lane name. The fingerprint of what they were shown rides along.
  let typed = null;
  try {
    typed = await deps.elicit(discardMessage(ctx, deps, plan, opts), TYPED_SCHEMA(opts.lane));
  } catch (error) {
    deps.warn?.(`teardown discard confirmation failed: ${error?.message ?? error}`);
  }
  if (typed?.action !== 'accept') throw new BlockedError(notConfirmed);
  if (typeof typed.content?.lane !== 'string' || typed.content.lane.trim() !== opts.lane) {
    throw new BlockedError(`The name typed did not match ${opts.lane}. ${notConfirmed}`);
  }
  return invoke('teardown', { ...args, force: true, expect: plan.fingerprint }, deps);
}
