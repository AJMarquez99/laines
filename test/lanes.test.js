import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCreate } from '../src/commands/create.js';
import { runReport, runKeep, runRelease, runList, runStatus } from '../src/commands/lanes.js';
import { loadContainer } from '../src/lib/container.js';
import { readLanes } from '../src/lib/lanes-store.js';
import { InvalidInputError } from '../src/lib/errors.js';
import { cleanupTmp, setupContainer, runCli } from './helpers.js';

afterEach(cleanupTmp);

async function oneLane() {
  const s = await setupContainer();
  const lane = await runCreate({ container: s.container }, s.deps);
  return { ...s, lane };
}

describe('report', () => {
  it('updates fields, clears with "-", and logs notes', async () => {
    const { deps, container, lane } = await oneLane();
    const r = await runReport({ lane: 'lane_1', status: 'in-progress', task: 'webhooks', blocked: 'staging creds', container }, deps);
    expect(r).toMatchObject({ lane: 'lane_1', status: 'in-progress', task: 'webhooks', blocked: 'staging creds' });
    const cleared = await runReport({ blocked: '-', container }, { ...deps, cwd: () => lane.path });
    expect(cleared.blocked).toBeNull();
    await runReport({ lane: 'lane_1', note: 'opened PR #12', container }, deps);
    const ctx = loadContainer({ container }, deps);
    expect(readLanes(ctx).activity[0].text).toBe('opened PR #12');
    expect(readFileSync(ctx.paths.board, 'utf8')).toContain('- **Task:** webhooks');
  });

  it('refuses nothing-to-report, empty or oversized text, and unknown lanes', async () => {
    const { deps, container } = await oneLane();
    const bad = [
      { lane: 'lane_1' },
      { lane: 'lane_1', status: '   ' },
      { lane: 'lane_1', task: 'x'.repeat(501) },
      { lane: 'nope', status: 'x' },
    ];
    for (const opts of bad) {
      await expect(runReport({ ...opts, container }, deps), JSON.stringify(opts).slice(0, 60)).rejects.toBeInstanceOf(InvalidInputError);
    }
  });
});

describe('keep and release', () => {
  it('pins a lane with a reason and releases it idempotently', async () => {
    const { deps, container } = await oneLane();
    await expect(runKeep({ lane: 'lane_1', container }, deps)).rejects.toBeInstanceOf(InvalidInputError);
    const k = await runKeep({ lane: 'lane_1', reason: 'base of stacked PR #12', container }, deps);
    expect(k.kept).toEqual({ reason: 'base of stacked PR #12', since: '2026-09-29T12:00:00.000Z' });
    const ctx = loadContainer({ container }, deps);
    expect(readFileSync(ctx.paths.board, 'utf8')).toContain('### lane_1 📌');
    expect(await runRelease({ lane: 'lane_1', container }, deps)).toEqual({ lane: 'lane_1', released: true });
    expect(await runRelease({ lane: 'lane_1', container }, deps)).toEqual({ lane: 'lane_1', released: false });
    await expect(runRelease({ container }, deps)).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe('list and status', () => {
  it('summarises lanes and shows one lane in detail', async () => {
    const { deps, container, lane } = await oneLane();
    const l = await runList({ container }, deps);
    expect(l.container).toEqual({ id: 'my-app', path: container, portRange: [20000, 20199] });
    expect(l.lanes).toEqual([expect.objectContaining({ lane: 'lane_1', number: 1, state: 'active', status: 'idle', branch: 'main', ports: [20000, 20009], kept: null, path: lane.path })]);
    const overview = await runStatus({ container }, deps);
    expect(overview.lanes).toHaveLength(1);
    expect(overview.requests).toEqual([]);
    const one = await runStatus({}, { ...deps, cwd: () => lane.path });
    expect(one).toMatchObject({ lane: 'lane_1', id: 'my-app/lane_1', envFile: join(lane.path, '.laines.env'), state: 'active' });
  });

  it('hides closed lanes unless --all', async () => {
    const { deps, container } = await oneLane();
    const file = join(container, '.laines', 'lanes.json');
    const state = JSON.parse(readFileSync(file, 'utf8'));
    state.lanes.lane_1.state = 'closed';
    (await import('node:fs')).writeFileSync(file, JSON.stringify(state));
    expect((await runList({ container }, deps)).lanes).toEqual([]);
    expect((await runList({ container, all: true }, deps)).lanes).toHaveLength(1);
  });

  it('wires the commands into the CLI', async () => {
    const { deps, container } = await oneLane();
    const report = await runCli(['report', 'lane_1', '--status', 'review', '--container', container, '--format', 'table'], deps);
    expect(report.code).toBe(0);
    expect(report.stdout).toContain('lane_1: status=review');
    const list = await runCli(['list', '--container', container, '--format', 'table'], deps);
    expect(list.stdout).toContain('lane_1');
    const keep = await runCli(['keep', 'lane_1', '--reason', 'stack', '--container', container], deps);
    expect(keep.code).toBe(0);
    const release = await runCli(['release', 'lane_1', '--container', container], deps);
    expect(JSON.parse(release.stdout).released).toBe(true);
  });
});
