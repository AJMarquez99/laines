import { loadConfig, patchConfig, previewConfigPatch } from '../config.js';
import { containerPaths } from '../lib/paths.js';
import { containerDirFrom, loadContainer, resolveContainer } from '../lib/container.js';
import { getPath } from '../lib/jsonfile.js';
import { updateLanes } from '../lib/lanes-store.js';
import { appendAudit } from '../lib/audit.js';
import { InvalidInputError } from '../lib/errors.js';

export async function runConfigGet(opts, deps) {
  const root = resolveContainer(containerDirFrom(opts, deps));
  const config = loadConfig(containerPaths(root).config);
  if (!opts.key) return config;
  const value = getPath(config, opts.key);
  if (value === undefined) throw new InvalidInputError(`Unknown config key "${opts.key}".`);
  return { key: opts.key, value };
}

// JSON when it parses (true, 20, ["claude"]); anything else is a plain string.
export function parseConfigValue(text) {
  try {
    return JSON.parse(text);
  } catch {
    return String(text);
  }
}

// Human-only (deny rules in agent settings); refused in a locked container (registry).
export async function runConfigSet(opts, deps) {
  if (!opts.key || opts.value === undefined) throw new InvalidInputError('Usage: laines config set <key> <value>');
  const ctx = loadContainer(opts, deps);
  const to = parseConfigValue(opts.value);
  const from = getPath(ctx.config, opts.key) ?? null;
  const next = previewConfigPatch(ctx.paths.config, opts.key, to);
  const changed = JSON.stringify(from) !== JSON.stringify(getPath(next, opts.key) ?? null);
  if (opts.dryRun || !changed) return { dryRun: Boolean(opts.dryRun), key: opts.key, from, to, changed };
  ctx.config = patchConfig(ctx.paths.config, opts.key, to);
  const now = deps.now();
  // Audited as soon as the file changes, so a board-lock timeout below cannot leave it unrecorded.
  appendAudit(ctx.paths.audit, { ts: now, action: 'config-set', container: ctx.id, key: opts.key, from, to }, { warn: deps.warn });
  await updateLanes(ctx, deps, (state) => ({
    state,
    result: null,
    activity: [{ ts: now, lane: null, text: `config set ${opts.key}: ${JSON.stringify(from)} → ${JSON.stringify(to)}` }],
  }));
  return { dryRun: false, key: opts.key, from, to, changed: true };
}
