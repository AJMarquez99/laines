import { z } from 'zod';
import { parseWith } from './schema.js';

const Lane = z.strictObject({
  number: z.number().int().positive(),
  repos: z.array(z.strictObject({ name: z.string(), path: z.string(), branch: z.string() })).min(1),
  ports: z.tuple([z.number().int(), z.number().int()]),
  state: z.enum(['active', 'setup-failed', 'closed']),
  status: z.string(),
  task: z.string().nullable(),
  blocked: z.string().nullable(),
  kept: z.strictObject({ reason: z.string(), since: z.string() }).nullable(),
  created: z.string(),
  updated: z.string(),
  closed: z.string().nullable().optional(),
});

export const LanesStateSchema = z.strictObject({
  version: z.literal(1),
  lanes: z.record(z.string(), Lane),
  requests: z.array(
    z.strictObject({
      id: z.string(),
      ts: z.string(),
      lane: z.string().nullable(),
      kind: z.string(),
      text: z.string(),
      command: z.string(),
    }),
  ),
  hookHistory: z.array(z.strictObject({ ts: z.string(), checksums: z.record(z.string(), z.string()) })),
  activity: z.array(z.strictObject({ ts: z.string(), lane: z.string().nullable(), text: z.string() })),
});

export const emptyLanesState = () => ({ version: 1, lanes: {}, requests: [], hookHistory: [], activity: [] });

export const parseLanesState = (data, file) => parseWith(LanesStateSchema, data, file);

// Pure: returns a new state; entries beyond logLimit come back as overflow for the caller to archive.
// A missing logLimit means unlimited: nothing overflows.
export function addActivity(state, entry, logLimit) {
  const limit = logLimit ?? Infinity;
  const all = [entry, ...state.activity];
  return { state: { ...state, activity: all.slice(0, limit) }, overflow: all.slice(limit) };
}
