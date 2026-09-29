import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadIndex, claimContainer, releaseContainer, pruneIndex } from '../src/lib/machine-index.js';
import { InvalidInputError, MalformedConfigError } from '../src/lib/errors.js';
import { tmp, cleanupTmp } from './helpers.js';

afterEach(cleanupTmp);
const now = '2026-09-29T12:00:00.000Z';

describe('machine index', () => {
  it('starts empty with the default machine range', () => {
    const idx = loadIndex(join(tmp(), 'cfg'));
    expect(idx).toEqual({ version: 1, machine: { range: [20000, 29999], blockSize: 200 }, containers: [] });
  });

  it('claims unique ids and non-overlapping blocks, even in parallel', async () => {
    const dir = join(tmp(), 'cfg');
    const entries = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => claimContainer(dir, { path: `/c/${n}`, baseId: 'app', now })),
    );
    const ids = entries.map((e) => e.id).sort();
    expect(ids).toEqual(['app', 'app-2', 'app-3', 'app-4', 'app-5']);
    const blocks = entries.map((e) => e.portRange).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < blocks.length; i++) expect(blocks[i][0]).toBeGreaterThan(blocks[i - 1][1]);
    expect(loadIndex(dir).containers).toHaveLength(5);
  });

  it('honours an explicit id and refuses a taken one or a registered path', async () => {
    const dir = join(tmp(), 'cfg');
    const e = await claimContainer(dir, { path: '/c/a', id: 'web', baseId: 'app', now });
    expect(e.id).toBe('web');
    await expect(claimContainer(dir, { path: '/c/b', id: 'web', baseId: 'app', now })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(claimContainer(dir, { path: '/c/a', baseId: 'app', now })).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('uses a custom block size', async () => {
    const dir = join(tmp(), 'cfg');
    const e = await claimContainer(dir, { path: '/c/a', baseId: 'app', blockSize: 50, now });
    expect(e.portRange).toEqual([20000, 20049]);
  });

  it('releases and prunes', async () => {
    const root = tmp();
    const dir = join(root, 'cfg');
    const live = join(root, 'live');
    mkdirSync(join(live, '.laines'), { recursive: true });
    writeFileSync(join(live, '.laines', 'container.json'), '{}');
    await claimContainer(dir, { path: live, baseId: 'live', now });
    await claimContainer(dir, { path: join(root, 'gone'), baseId: 'gone', now });
    await claimContainer(dir, { path: join(root, 'x'), baseId: 'x', now });
    await releaseContainer(dir, 'x');
    const removed = await pruneIndex(dir);
    expect(removed.map((e) => e.id)).toEqual(['gone']);
    expect(loadIndex(dir).containers.map((e) => e.id)).toEqual(['live']);
  });

  it('rejects a malformed index with exit-2 error', () => {
    const dir = join(tmp(), 'cfg');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'containers.json'), JSON.stringify({ version: 1, containers: 'nope' }));
    expect(() => loadIndex(dir)).toThrow(MalformedConfigError);
  });
});
