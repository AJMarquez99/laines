import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLanes, updateLanes } from '../src/lib/lanes-store.js';
import { buildConfig } from '../src/config.js';
import { containerPaths } from '../src/lib/paths.js';
import { MalformedConfigError } from '../src/lib/errors.js';
import { tmp, cleanupTmp, testDeps } from './helpers.js';

afterEach(cleanupTmp);

function ctxFor(root, logLimit = 200) {
  const config = buildConfig({ repoName: 'app', remote: 'git@example.com:o/app.git', defaultBranch: 'main', agents: ['claude'] });
  config.board.logLimit = logLimit;
  return { root, paths: containerPaths(root), id: 'app', config, portRange: [20000, 20199] };
}

const lane = (n, over = {}) => ({
  number: n,
  repos: [{ name: 'app', path: `lane_${n}`, branch: 'main' }],
  ports: [20000 + (n - 1) * 10, 20009 + (n - 1) * 10],
  state: 'active',
  status: 'idle',
  task: null,
  blocked: null,
  kept: null,
  created: '2026-09-29T12:00:00.000Z',
  updated: '2026-09-29T12:00:00.000Z',
  closed: null,
  ...over,
});

describe('lanes store', () => {
  it('reads an empty state, writes lanes.json and regenerates the board', async () => {
    const root = tmp();
    const ctx = ctxFor(root);
    const deps = testDeps(root);
    expect(readLanes(ctx).lanes).toEqual({});
    const r = await updateLanes(ctx, deps, (s) => {
      s.lanes.lane_1 = lane(1);
      return { state: s, result: 'ok', activity: [{ ts: deps.now(), lane: 'lane_1', text: 'created' }] };
    });
    expect(r).toBe('ok');
    expect(readLanes(ctx).lanes.lane_1.number).toBe(1);
    const board = readFileSync(ctx.paths.board, 'utf8');
    expect(board).toContain('<!-- lane:lane_1:start -->');
    expect(board).toContain('`lane_1`: created');
    expect(existsSync(ctx.paths.lock)).toBe(false);
  });

  it('writes nothing when mutate throws or returns an invalid state', async () => {
    const root = tmp();
    const ctx = ctxFor(root);
    const deps = testDeps(root);
    await updateLanes(ctx, deps, (s) => ({ state: s, result: null }));
    const before = readFileSync(ctx.paths.lanes, 'utf8');
    await expect(updateLanes(ctx, deps, () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(updateLanes(ctx, deps, (s) => {
      s.lanes.bad = { number: 'x' };
      return { state: s, result: null };
    })).rejects.toBeInstanceOf(MalformedConfigError);
    expect(readFileSync(ctx.paths.lanes, 'utf8')).toBe(before);
    expect(existsSync(ctx.paths.lock)).toBe(false);
  });

  it('rolls activity beyond logLimit into the dated archive file', async () => {
    const root = tmp();
    const ctx = ctxFor(root, 10);
    const deps = testDeps(root);
    const entries = Array.from({ length: 12 }, (_, i) => ({ ts: `2026-09-29T12:${String(i).padStart(2, '0')}:00.000Z`, lane: null, text: `e${i + 1}` }));
    await updateLanes(ctx, deps, (s) => ({ state: s, result: null, activity: entries }));
    const state = readLanes(ctx);
    expect(state.activity).toHaveLength(10);
    expect(state.activity[0].text).toBe('e12');
    const archive = readFileSync(join(ctx.paths.ai, 'archive', '2026-09-29_board-log.md'), 'utf8');
    const lines = archive.split('\n');
    expect(archive).toContain('# Board activity archive: app');
    expect(archive).toContain('oldest first');
    const entryLines = lines.filter((l) => l.startsWith('- **'));
    expect(entryLines).toEqual(['- **2026-09-29 12:00 UTC** · e1', '- **2026-09-29 12:01 UTC** · e2']);
    // Verify e3 is not in the archive
    expect(archive).not.toContain('e3');
  });

  it('serialises concurrent updates without losing any', async () => {
    const root = tmp();
    const ctx = ctxFor(root);
    const deps = testDeps(root);
    await Promise.all([1, 2, 3, 4].map((n) => updateLanes(ctx, deps, (s) => {
      s.lanes[`lane_${n}`] = lane(n);
      return { state: s, result: null };
    })));
    expect(Object.keys(readLanes(ctx).lanes).sort()).toEqual(['lane_1', 'lane_2', 'lane_3', 'lane_4']);
  });

  it('rejects malformed activity entries and leaves state unchanged', async () => {
    const root = tmp();
    const ctx = ctxFor(root);
    const deps = testDeps(root);
    // Create initial state
    await updateLanes(ctx, deps, (s) => {
      s.lanes.lane_1 = lane(1);
      return { state: s, result: 'created' };
    });
    const beforeLanes = readFileSync(ctx.paths.lanes, 'utf8');
    const beforeBoard = readFileSync(ctx.paths.board, 'utf8');
    const archivePath = join(ctx.paths.ai, 'archive', '2026-09-29_board-log.md');
    const archiveExistedBefore = existsSync(archivePath);
    // Try to update with malformed activity (missing `lane` key)
    await expect(updateLanes(ctx, deps, (s) => {
      return { state: s, result: null, activity: [{ ts: deps.now(), text: 'no lane key' }] };
    })).rejects.toBeInstanceOf(MalformedConfigError);
    // Verify state is unchanged
    expect(readFileSync(ctx.paths.lanes, 'utf8')).toBe(beforeLanes);
    expect(readFileSync(ctx.paths.board, 'utf8')).toBe(beforeBoard);
    expect(existsSync(archivePath)).toBe(archiveExistedBefore);
    expect(existsSync(ctx.paths.lock)).toBe(false);
  });

  it('accepts a hand-edited adopted: false (read as absent)', async () => {
    const root = tmp();
    const ctx = ctxFor(root);
    const deps = testDeps(root);
    await updateLanes(ctx, deps, (s) => {
      s.lanes.lane_1 = lane(1, { adopted: false });
      return { state: s, result: null };
    });
    expect(readLanes(ctx).lanes.lane_1.adopted).toBe(false);
  });

  it('archives overflow oldest first when the log is already full', async () => {
    const root = tmp();
    const ctx = ctxFor(root, 10);
    const deps = testDeps(root);
    const at = (i) => ({ ts: `2026-09-29T12:${String(i).padStart(2, '0')}:00.000Z`, lane: null, text: `e${i}` });
    await updateLanes(ctx, deps, (s) => ({ state: s, result: null, activity: Array.from({ length: 10 }, (_, i) => at(i + 1)) }));
    await updateLanes(ctx, deps, (s) => ({ state: s, result: null, activity: [at(11), at(12), at(13)] }));
    const archived = readFileSync(join(ctx.paths.ai, 'archive', '2026-09-29_board-log.md'), 'utf8').split('\n').filter((l) => l.startsWith('- **'));
    expect(archived.map((l) => l.split(' · ')[1])).toEqual(['e1', 'e2', 'e3']);
    expect(readLanes(ctx).activity.map((a) => a.text)).toEqual(['e13', 'e12', 'e11', 'e10', 'e9', 'e8', 'e7', 'e6', 'e5', 'e4']);
  });
});
