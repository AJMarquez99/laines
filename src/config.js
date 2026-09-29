import { dirname } from 'node:path';
import { z } from 'zod';
import { readJson } from './lib/jsonfile.js';
import { parseWith } from './lib/schema.js';
import { NotAContainerError } from './lib/errors.js';

const Repo = z.strictObject({
  remote: z.string().min(1),
  defaultBranch: z.string().min(1).default('main'),
});

export const ConfigSchema = z.strictObject({
  repos: z
    .record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'repo names use lowercase letters, digits and hyphens'), Repo)
    .refine((r) => Object.keys(r).length === 1, 'exactly one repo is supported in this version'),
  lanePrefix: z.string().regex(/^[a-z][a-z0-9_-]*$/).default('lane_'),
  maxLanes: z.number().int().min(1).max(200).default(20),
  ports: z.strictObject({ stride: z.number().int().min(1).max(100).default(10) }).prefault({}),
  hooks: z
    .strictObject({
      policy: z.enum(['approve', 'notify', 'open']).default('notify'),
      timeoutSec: z.number().int().min(1).max(3600).default(300),
      stableAfter: z.number().int().min(1).max(100).default(3),
    })
    .prefault({}),
  teardown: z.strictObject({ mcp: z.enum(['confirm', 'auto', 'off']).default('confirm') }).prefault({}),
  capabilities: z
    .strictObject({
      create: z.boolean().default(true),
      report: z.boolean().default(true),
      keep: z.boolean().default(true),
      teardown: z.boolean().default(true),
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
      throw new NotAContainerError(dirname(dirname(file)));
    },
  });
  return parseWith(ConfigSchema, raw, file);
}
