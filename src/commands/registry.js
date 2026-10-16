import { loadConfig } from '../config.js';
import { appendAudit } from '../lib/audit.js';
import { containerDirFrom, resolveContainer } from '../lib/container.js';
import { readJson } from '../lib/jsonfile.js';
import { containerPaths } from '../lib/paths.js';
import { BlockedError, CapabilityDeniedError, InvalidInputError } from '../lib/errors.js';
import { runInit } from './init.js';
import { runAdopt } from './adopt.js';
import { runConfigGet, runConfigSet } from './config.js';
import { runDoctor } from './doctor.js';
import { runBrief } from './brief.js';
import { runCreate } from './create.js';
import { runRefresh } from './refresh.js';
import { runReport, runKeep, runRelease, runList, runStatus } from './lanes.js';
import { runTeardown } from './teardown.js';
import { runAiSync } from './ai-sync.js';
import { runHooksStatus, runHooksApprove, runHooksPolicy } from './hooks.js';
import { runWatch } from './watch.js';

const always = () => true;

// Every command's safety decision lives here (spec §6.1, §9). `capability` gates CLI and MCP alike
// (exit 4). `locked(opts)` says what `locked: true` refuses (exit 3). `humanOnly` commands carry
// agent deny rules (HUMAN_ONLY_COMMANDS) and reach MCP only through a human confirmation. `gate`
// commands are never run from a hook, even with hooks.manage (see refuseFromHook).
export const COMMANDS = {
  init: { run: runInit, capability: null },
  // A gate too: it makes a new container, so there is no container config to consult.
  adopt: { run: runAdopt, capability: null, humanOnly: true, gate: true },
  'config get': { run: runConfigGet, capability: null },
  'config set': { run: runConfigSet, capability: null, humanOnly: true, gate: true, locked: always },
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
  'hooks approve': { run: runHooksApprove, capability: null, humanOnly: true, gate: true, locked: always },
  'hooks policy': { run: runHooksPolicy, capability: null, humanOnly: true, gate: true, locked: always },
  'ai sync': { run: runAiSync, capability: 'aiSync' },
  // Listed for the coverage guard only: it streams, so the CLI drives runWatch directly with a
  // signal and a writer, and it is never invoked through here or exposed over MCP.
  watch: { run: runWatch, capability: null },
};

// A guardrail against accidents, not a control: a hook is code running as the user and can unset
// LAINES_HOOK, edit .laines/config.json, or skip laines entirely. The hook policy (`approve`) is
// the boundary.
function refuseFromHook(name, entry, opts, deps) {
  const event = deps.env?.LAINES_HOOK;
  if (!entry.humanOnly || !event) return;
  let paths = null;
  try {
    paths = containerPaths(resolveContainer(containerDirFrom(opts, deps)));
  } catch {
    // No container to consult or audit (adopt, or a bad --container): refuse all the same.
  }
  if (!entry.gate && paths && loadConfig(paths.config).hooks.manage) return;
  if (paths) {
    const container = readJson(paths.marker)?.id ?? null;
    appendAudit(paths.audit, { ts: deps.now(), action: 'hook-refused', container, command: name, event }, { warn: deps.warn });
  }
  const head = `\`laines ${name}\` was run from a ${event} hook and is refused`;
  throw new BlockedError(
    entry.gate
      ? `${head}: a hook may never run it. Run it yourself from a shell.`
      : `${head}. To let hooks run teardown and release, a human runs \`laines config set hooks.manage true\`.`,
  );
}

// The single choke point both the CLI and the MCP server call.
export async function invoke(name, opts = {}, deps) {
  const entry = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!entry) throw new InvalidInputError(`Unknown command "${name}".`);
  refuseFromHook(name, entry, opts, deps);
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
