import { loadConfig } from '../config.js';
import { containerDirFrom, resolveContainer } from '../lib/container.js';
import { containerPaths } from '../lib/paths.js';
import { BlockedError, CapabilityDeniedError, InvalidInputError } from '../lib/errors.js';
import { runInit } from './init.js';
import { runConfigGet, runConfigSet } from './config.js';
import { runDoctor } from './doctor.js';
import { runBrief } from './brief.js';
import { runCreate } from './create.js';
import { runRefresh } from './refresh.js';
import { runReport, runKeep, runRelease, runList, runStatus } from './lanes.js';
import { runTeardown } from './teardown.js';
import { runHooksStatus, runHooksApprove, runHooksPolicy } from './hooks.js';
import { runWatch } from './watch.js';

const always = () => true;

// Every command's safety decision lives here (spec §6.1, §9). `capability` gates CLI and MCP alike
// (exit 4). `locked(opts)` says what `locked: true` refuses (exit 3). `humanOnly` commands carry
// agent deny rules (HUMAN_ONLY_COMMANDS) and reach MCP only through a human confirmation.
export const COMMANDS = {
  init: { run: runInit, capability: null },
  'config get': { run: runConfigGet, capability: null },
  'config set': { run: runConfigSet, capability: null, humanOnly: true, locked: always },
  doctor: { run: runDoctor, capability: null },
  brief: { run: runBrief, capability: null },
  create: { run: runCreate, capability: 'create' },
  refresh: { run: runRefresh, capability: 'create' },
  report: { run: runReport, capability: 'report' },
  keep: { run: runKeep, capability: 'keep' },
  release: { run: runRelease, capability: null, humanOnly: true, locked: always },
  list: { run: runList, capability: null },
  status: { run: runStatus, capability: null },
  teardown: { run: runTeardown, capability: 'teardown', humanOnly: true, locked: (opts) => Boolean(opts.force) },
  'hooks status': { run: runHooksStatus, capability: null },
  'hooks approve': { run: runHooksApprove, capability: null, humanOnly: true, locked: always },
  'hooks policy': { run: runHooksPolicy, capability: null, humanOnly: true, locked: always },
  // Listed for the coverage guard only: it streams, so the CLI drives runWatch directly with a
  // signal and a writer, and it is never invoked through here or exposed over MCP.
  watch: { run: runWatch, capability: null },
};

// The single choke point both the CLI and the MCP server call.
export async function invoke(name, opts = {}, deps) {
  const entry = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!entry) throw new InvalidInputError(`Unknown command "${name}".`);
  const lockable = entry.locked?.(opts) ?? false;
  if (entry.capability || lockable) {
    const config = loadConfig(containerPaths(resolveContainer(containerDirFrom(opts, deps))).config);
    if (lockable && config.locked) {
      throw new BlockedError(
        `This container is locked ("locked": true in .laines/config.json), so \`laines ${name}\` is refused. ` +
          'Unlocking requires editing that file by hand.',
      );
    }
    if (entry.capability && !config.capabilities[entry.capability]) throw new CapabilityDeniedError(entry.capability, name);
  }
  return entry.run(opts, deps);
}
