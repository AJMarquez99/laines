import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { invoke } from '../commands/registry.js';
import { loadContainer } from '../lib/container.js';
import { getLane, readLanes, updateLanes } from '../lib/lanes-store.js';
import { putRequest } from '../lib/lanes-state.js';
import { untrackedEntries } from '../lib/lane-files.js';
import { holdingLines } from '../lib/lane-git.js';
import { BlockedError, InvalidInputError } from '../lib/errors.js';

export const CONFIRM_SCHEMA = {
  type: 'object',
  properties: { confirm: { type: 'boolean', title: 'Tear down this lane' } },
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

// Exactly what a forced teardown will lose, for the second (typed) form.
function discardMessage(deps, plan, opts) {
  const { checks } = plan;
  // A ref deleted since the dry run shows no subjects; the fingerprint refuses the run anyway.
  const subjects = (ref) => {
    const r = deps.git(['log', '--format=%s', '-n', '3', ref, '--not', '--remotes'], { cwd: plan.path });
    return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
  };
  const dirty = checks.dirty.slice(0, 10).map((f) => `  - ${f}`);
  if (checks.dirty.length > 10) dirty.push(`  - and ${checks.dirty.length - 10} more`);
  return [
    `This permanently discards work in lane ${opts.lane} (${plan.path}):`,
    ...checks.refs.flatMap((r) => [`- ${r.ref}: ${r.commits} commit(s) on no remote`, ...subjects(r.ref).map((t) => `    ${t}`)]),
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
  const unpushed = plan.blocked
    ? ['present (the next prompt asks you to type the lane name to discard it)', ...plan.checks.problems.map((p) => `    ${p}`), ...holdingLines(plan.checks.holdings)].join('\n')
    : !opts.removeDir ? 'not checked (the clone stays)' : plan.checks === null ? 'not checked (no clone)' : 'none';
  const clone = plan.removedDir ? 'deleted (remove_dir)' : opts.removeDir ? 'no clone to delete' : 'left in place';
  const hooks = plan.hooks.flatMap((h) => h.hooks.map((x) => `${x.hook} (${x.state})`)).join(', ') || 'none';
  return [
    `Tear down lane ${opts.lane} of container ${ctx.id}?`,
    `- Branch: ${lane.repos[0].branch}`,
    `- Path: ${plan.path}`,
    `- Archived: ${plans} entr${plans === 1 ? 'y' : 'ies'} of .ai/plans/ move to the container's .ai/archive/; .ai/context/ is deleted`,
    `- Clone: ${clone}`,
    `- Unpushed work: ${unpushed}`,
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
  const args = { lane: opts.lane, removeDir: opts.removeDir, container: opts.container };
  if (opts.dryRun || mode === 'auto') return invoke('teardown', { ...args, dryRun: opts.dryRun }, deps);

  // The dry run applies every check (capability, keep, closed, unpushed work) and touches nothing.
  const plan = await invoke('teardown', { ...args, dryRun: true }, deps);
  // Only unpushed work can be forced, and only when a human can be asked and the container is not locked.
  const canForce = plan.blocked && getLane(readLanes(ctx), opts.lane).state !== 'closed' && existsSync(join(plan.path, '.git')) && ctx.config.teardown.mcpForce === 'confirm' && !ctx.config.locked && Boolean(deps.canElicit?.());
  if (plan.blocked && !canForce) throw new BlockedError(plan.refusal); // never re-run the real teardown without an accept
  const command = `laines teardown ${opts.lane}${opts.removeDir ? ' --remove-dir' : ''}`;
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
    answer = await deps.elicit(message, CONFIRM_SCHEMA);
  } catch (error) {
    deps.warn?.(`teardown confirmation failed: ${error?.message ?? error}`); // a timeout or a client error is no answer
  }
  if (answer?.action !== 'accept' || answer.content?.confirm !== true) throw new BlockedError(declinedMessage(opts.lane));
  if (!plan.blocked) return invoke('teardown', args, deps);

  // The second form: the human types the lane name. The fingerprint of what they were shown rides along.
  let typed = null;
  try {
    typed = await deps.elicit(discardMessage(deps, plan, opts), TYPED_SCHEMA(opts.lane));
  } catch (error) {
    deps.warn?.(`teardown discard confirmation failed: ${error?.message ?? error}`);
  }
  if (typed?.action !== 'accept') throw new BlockedError(notConfirmed);
  if (typeof typed.content?.lane !== 'string' || typed.content.lane.trim() !== opts.lane) {
    throw new BlockedError(`The name typed did not match ${opts.lane}. ${notConfirmed}`);
  }
  return invoke('teardown', { ...args, force: true, expect: plan.fingerprint }, deps);
}
