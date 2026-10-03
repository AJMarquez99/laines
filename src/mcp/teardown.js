import { existsSync } from 'node:fs';
import { invoke } from '../commands/registry.js';
import { loadContainer } from '../lib/container.js';
import { getLane, readLanes, updateLanes } from '../lib/lanes-store.js';
import { putRequest } from '../lib/lanes-state.js';
import { untrackedEntries } from '../lib/lane-files.js';
import { BlockedError, InvalidInputError } from '../lib/errors.js';

export const CONFIRM_SCHEMA = {
  type: 'object',
  properties: { confirm: { type: 'boolean', title: 'Tear down this lane' } },
  required: ['confirm'],
};

export const declinedMessage = (lane) =>
  `Declined or no response — if you weren't prompted, run \`laines teardown ${lane}\` in your terminal.`;

function confirmMessage(ctx, deps, plan, opts) {
  const lane = getLane(readLanes(ctx), opts.lane);
  const plans = existsSync(plan.path) ? untrackedEntries(deps, plan.path, '.ai/plans').length : 0;
  const unpushed = !opts.removeDir ? 'not checked (the clone stays)' : plan.checks === null ? 'not checked (no clone)' : 'none';
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
  if (plan.blocked) throw new BlockedError(plan.refusal); // never re-run the real teardown without an accept
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
  return invoke('teardown', args, deps);
}
