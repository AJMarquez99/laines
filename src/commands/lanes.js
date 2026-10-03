import { join } from 'node:path';
import { detectLane, laneFrom, loadContainer } from '../lib/container.js';
import { getLane, readLanes, updateLanes } from '../lib/lanes-store.js';
import { laneId } from '../lib/ids.js';
import { dropRequests, requestId } from '../lib/lanes-state.js';
import { appendAudit } from '../lib/audit.js';
import { InvalidInputError } from '../lib/errors.js';

const MAX_TEXT = 500;

function text(value, label) {
  const s = String(value).trim();
  if (!s) throw new InvalidInputError(`${label} must not be empty.`);
  if (s.length > MAX_TEXT) throw new InvalidInputError(`${label} is longer than ${MAX_TEXT} characters.`);
  return s;
}

function openLane(state, name) {
  const lane = getLane(state, name);
  if (!lane) throw new InvalidInputError(`No lane named ${name}. See \`laines list\`.`);
  if (lane.state === 'closed') throw new InvalidInputError(`Lane ${name} is closed.`);
  return lane;
}

const summary = (ctx, name, l) => ({
  lane: name,
  number: l.number,
  state: l.state,
  status: l.status,
  task: l.task,
  branch: l.repos[0].branch,
  ports: l.ports,
  kept: l.kept,
  path: join(ctx.root, l.repos[0].path),
  updated: l.updated,
});

export async function runReport(opts, deps) {
  const ctx = loadContainer(opts, deps);
  const name = laneFrom(opts, deps, ctx);
  const changes = ['status', 'task', 'blocked'].filter((k) => opts[k] !== undefined);
  if (!changes.length && opts.note === undefined) {
    throw new InvalidInputError('Nothing to report: pass --status, --task, --blocked or --note.');
  }
  const status = opts.status !== undefined ? text(opts.status, '--status') : undefined;
  const task = opts.task === undefined ? undefined : opts.task === '-' ? null : text(opts.task, '--task');
  const blocked = opts.blocked === undefined ? undefined : opts.blocked === '-' ? null : text(opts.blocked, '--blocked');
  const note = opts.note !== undefined ? text(opts.note, '--note') : null;
  const now = deps.now();
  return updateLanes(ctx, deps, (state) => {
    const l = openLane(state, name);
    if (status !== undefined) l.status = status;
    if (task !== undefined) l.task = task;
    if (blocked !== undefined) l.blocked = blocked;
    if (changes.length) l.updated = now;
    const line = note ?? `status=${l.status}, task=${l.task ?? '-'}${l.blocked ? `, blocked on ${l.blocked}` : ''}`;
    return {
      state,
      result: { lane: name, status: l.status, task: l.task, blocked: l.blocked, updated: l.updated },
      activity: [{ ts: now, lane: name, text: line }],
    };
  });
}

export async function runKeep(opts, deps) {
  const ctx = loadContainer(opts, deps);
  const name = laneFrom(opts, deps, ctx);
  if (opts.reason === undefined) throw new InvalidInputError('--reason is required: say what depends on this lane.');
  const reason = text(opts.reason, '--reason');
  const now = deps.now();
  const r = await updateLanes(ctx, deps, (state) => {
    const l = openLane(state, name);
    l.kept = { reason, since: l.kept?.since ?? now };
    l.updated = now;
    // A kept lane is not waiting on a teardown: withdraw its teardown-blocked and teardown-confirm requests.
    const withdrawn = new Set([requestId('teardown-blocked', name), requestId('teardown-confirm', name)]);
    return { state: dropRequests(state, (q) => withdrawn.has(q.id)), result: { lane: name, kept: l.kept }, activity: [{ ts: now, lane: name, text: `kept: ${reason}` }] };
  });
  appendAudit(ctx.paths.audit, { ts: now, action: 'keep', container: ctx.id, lane: name }, { warn: deps.warn });
  return r;
}

// Human-only (deny rules in agent settings); the lane must always be named.
export async function runRelease(opts, deps) {
  if (!opts.lane) throw new InvalidInputError('Name the lane to release: `laines release <lane>`.');
  const ctx = loadContainer(opts, deps);
  const name = opts.lane;
  const now = deps.now();
  const r = await updateLanes(ctx, deps, (state) => {
    const l = openLane(state, name);
    if (!l.kept) return { state, result: { lane: name, released: false } };
    l.kept = null;
    l.updated = now;
    return { state, result: { lane: name, released: true }, activity: [{ ts: now, lane: name, text: 'released (no longer kept)' }] };
  });
  if (r.released) appendAudit(ctx.paths.audit, { ts: now, action: 'release', container: ctx.id, lane: name }, { warn: deps.warn });
  return r;
}

export async function runList(opts, deps) {
  const ctx = loadContainer(opts, deps);
  const lanes = Object.entries(readLanes(ctx).lanes)
    .filter(([, l]) => opts.all || l.state !== 'closed')
    .sort(([, a], [, b]) => a.number - b.number)
    .map(([name, l]) => summary(ctx, name, l));
  return { container: { id: ctx.id, path: ctx.root, portRange: ctx.portRange }, lanes };
}

export async function runStatus(opts, deps) {
  const ctx = loadContainer(opts, deps);
  const state = readLanes(ctx);
  const name = opts.lane ?? detectLane(deps.cwd())?.lane;
  if (!name) {
    const lanes = Object.entries(state.lanes)
      .filter(([, l]) => l.state !== 'closed')
      .sort(([, a], [, b]) => a.number - b.number)
      .map(([n, l]) => summary(ctx, n, l));
    return { container: { id: ctx.id, path: ctx.root, portRange: ctx.portRange }, lanes, requests: state.requests };
  }
  const l = getLane(state, name);
  if (!l) throw new InvalidInputError(`No lane named ${name}. See \`laines list\`.`);
  const path = join(ctx.root, l.repos[0].path);
  return {
    lane: name,
    id: laneId(ctx.id, name),
    path,
    envFile: join(path, '.laines.env'),
    state: l.state,
    status: l.status,
    task: l.task,
    blocked: l.blocked,
    branch: l.repos[0].branch,
    ports: l.ports,
    kept: l.kept,
    created: l.created,
    updated: l.updated,
  };
}
