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
  // Set when the clone is deleted (at the close, or by a later teardown); branchAtRemoval is what the clone had checked out then.
  cloneRemoved: z.string().optional(),
  branchAtRemoval: z.string().optional(),
  // Set by `laines adopt`: the project's own Docker Compose project name, kept for lane_1.
  compose: z.string().optional(),
  // Set by `laines adopt`: the lane is the project's own checkout, so laines does not set PORT for it.
  adopted: z.literal(true).optional(),
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

export const requestId = (kind, lane) => `${kind}:${lane ?? '*'}`;

// Pure. One request per kind and lane: a repeat replaces the earlier one and moves to the top.
export function putRequest(state, { ts, lane = null, kind, text, command }) {
  const id = requestId(kind, lane);
  return { ...state, requests: [{ id, ts, lane, kind, text, command }, ...state.requests.filter((r) => r.id !== id)] };
}

export const dropRequests = (state, match) => ({ ...state, requests: state.requests.filter((r) => !match(r)) });

// A create in progress is "spinning up" too: only one older than a slow clone plus a full hook
// timeout counts as interrupted.
export function spinUpState(lane, config, now) {
  if (lane.status !== 'spinning up') return null;
  const staleMs = ((config?.hooks.timeoutSec ?? 300) + 1800) * 1000;
  const age = Date.parse(now) - Date.parse(lane.updated);
  // An unreadable timestamp can never become stale on its own: call it interrupted.
  return !Number.isFinite(age) || age > staleMs ? 'interrupted' : 'running';
}
