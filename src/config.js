import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { readJson, writeJson } from './lib/jsonfile.js';
import { parseWith } from './lib/schema.js';
import { InvalidInputError, MalformedConfigError, NotAContainerError } from './lib/errors.js';

// Both end up as git arguments: a leading "-" would be parsed as an option.
const gitArg = () => z.string().min(1).refine((s) => !s.startsWith('-'), 'must not start with "-"');

const Repo = z.strictObject({
  remote: gitArg(),
  defaultBranch: gitArg().default('main'),
});

export const ConfigSchema = z.strictObject({
  repos: z
    .record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'repo names use lowercase letters, digits and hyphens'), Repo)
    .refine((r) => Object.keys(r).length === 1, 'exactly one repo is supported in this version'),
  // At most 28, so `<prefix><N>` always fits LANE_NAME (32).
  lanePrefix: z.string().regex(/^[a-z][a-z0-9_-]*$/).max(28).default('lane_'),
  maxLanes: z.number().int().min(1).max(200).default(20),
  ports: z.strictObject({ stride: z.number().int().min(1).max(100).default(10) }).prefault({}),
  hooks: z
    .strictObject({
      policy: z.enum(['approve', 'notify', 'open']).default('notify'),
      timeoutSec: z.number().int().min(1).max(3600).default(300),
      stableAfter: z.number().int().min(1).max(100).default(3),
      // Lets hooks run teardown and release; see the guard in commands/registry.js.
      manage: z.boolean().default(false),
    })
    .prefault({}),
  teardown: z
    .strictObject({
      mcp: z.enum(['confirm', 'auto', 'off']).default('confirm'),
      mcpForce: z.enum(['confirm', 'off']).default('confirm'),
    })
    .prefault({}),
  capabilities: z
    .strictObject({
      create: z.boolean().default(true),
      report: z.boolean().default(true),
      keep: z.boolean().default(true),
      teardown: z.boolean().default(true),
      aiSync: z.boolean().default(true),
    })
    .prefault({}),
  agents: z
    .array(z.enum(['claude', 'codex', 'gemini']))
    .min(1)
    .refine((a) => new Set(a).size === a.length, 'agents must not repeat')
    .default(['claude']),
  agentCmd: z.string().min(1).default('claude'),
  board: z.strictObject({ logLimit: z.number().int().min(10).max(10000).default(200) }).prefault({}),
  locked: z.boolean().default(false),
});

export function buildConfig({ repoName, remote, defaultBranch, agents }) {
  return parseWith(ConfigSchema, { repos: { [repoName]: { remote, defaultBranch } }, agents }, '(new config)');
}

export function loadConfig(file) {
  const raw = readJson(file, {
    onMissing: () => {
      const laines = dirname(file);
      if (existsSync(join(laines, 'container.json'))) throw new MalformedConfigError(file, 'missing');
      throw new NotAContainerError(dirname(laines));
    },
  });
  return parseWith(ConfigSchema, raw, file);
}

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function patched(file, dotted, value) {
  const keys = String(dotted ?? '').split('.');
  if (keys.some((k) => !k || UNSAFE_KEYS.has(k))) throw new InvalidInputError(`Invalid config key "${dotted}".`);
  const raw = readJson(file, {
    onMissing: () => {
      throw new MalformedConfigError(file, 'missing');
    },
  });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new MalformedConfigError(file, 'expected a JSON object');
  let cur = raw;
  for (const k of keys.slice(0, -1)) {
    if (!Object.hasOwn(cur, k) || cur[k] === null || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys.at(-1)] = value;
  const r = ConfigSchema.safeParse(raw);
  if (!r.success) {
    const why = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new InvalidInputError(`Cannot set ${dotted}: ${why}`);
  }
  return { raw, config: r.data };
}

// Validates a one-key change and returns the resulting config, writing nothing.
export const previewConfigPatch = (file, dotted, value) => patched(file, dotted, value).config;

// Changes one key in the file as written (defaults stay implicit) after validating the whole config.
export function patchConfig(file, dotted, value) {
  const { raw, config } = patched(file, dotted, value);
  writeJson(file, raw);
  return config;
}
