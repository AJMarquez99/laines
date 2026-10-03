import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { invoke } from '../src/commands/registry.js';
import { loadContainer } from '../src/lib/container.js';
import { readLanes } from '../src/lib/lanes-store.js';
import { readAiBase, readAiBases, syncedState, writeAiBase } from '../src/lib/ai-tree.js';
import { BlockedError } from '../src/lib/errors.js';
import { cleanupTmp, connectMcp, setupContainer, setConfig, gitIn, runCli } from './helpers.js';

afterEach(cleanupTmp);

function put(root, rel, text) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
const read = (file) => readFileSync(file, 'utf8');

// A container whose repository commits .ai/knowledge/a.md, with lane_1 created and a first sync done.
async function synced() {
  const s = await setupContainer({ files: { 'README.md': '# app\n', '.ai/knowledge/a.md': 'A\n' } });
  const lane = await invoke('create', { container: s.container }, s.deps);
  const sync = (opts = {}) => invoke('ai sync', { lane: 'lane_1', container: s.container, ...opts }, s.deps);
  await sync();
  return { ...s, sync, cAi: join(s.container, '.ai'), lAi: join(lane.path, '.ai'), laneDir: lane.path };
}

describe('ai sync and laines container files', () => {
  it('a repo that commits .ai/ indexes: every README row in the lane links to a file that exists there, and _README.md is not synced', async () => {
    const readme = (n) => `# ${n}\n\n## Index\n\n| File | Answers |\n|---|---|\n| [x.md](x.md) | x |\n`;
    const s = await setupContainer({ files: {
      'README.md': '# app\n',
      '.ai/runbooks/README.md': readme('Runbooks'), '.ai/runbooks/x.md': 'x\n',
      '.ai/templates/README.md': readme('Templates'), '.ai/templates/x.md': 'x\n',
    } });
    const lane = await invoke('create', { container: s.container }, s.deps);
    await invoke('ai sync', { lane: 'lane_1', container: s.container }, s.deps);
    const lAi = join(lane.path, '.ai');
    for (const dir of ['runbooks', 'templates']) {
      const rows = [...read(join(lAi, dir, 'README.md')).matchAll(/^\|\s*\[[^\]]*\]\(([^)]+)\)/gm)].map((m) => m[1]);
      expect(rows.length).toBeGreaterThan(0);
      for (const target of rows) expect(existsSync(join(lAi, dir, target)), `${dir}/${target}`).toBe(true);
      expect(existsSync(join(lAi, dir, '_README.md')), dir).toBe(false);
      expect(read(join(lAi, dir, 'README.md'))).not.toContain('lane-');
    }
    expect(existsSync(join(lAi, 'runbooks', '_lane-management.md'))).toBe(false);
  });
});

describe('ai sync', () => {
  it('first sync merges both sides and records the base', async () => {
    const s = await synced();
    expect(read(join(s.cAi, 'knowledge', 'a.md'))).toBe('A\n');
    expect(existsSync(join(s.lAi, 'knowledge', 'README.md'))).toBe(true);
    expect(readAiBase(loadContainer({ container: s.container }, s.deps).paths, 'lane_1')['knowledge/a.md']).toMatch(/^sha256:/);
  });

  it('copies a container change into the lane, where it shows in git status', async () => {
    const s = await synced();
    put(s.cAi, 'knowledge/b.md', 'B\n');
    put(s.cAi, 'knowledge/a.md', 'A2\n');
    const r = await s.sync();
    expect(r).toMatchObject({ applies: true, toLane: ['knowledge/a.md', 'knowledge/b.md'], toContainer: [], conflicts: [] });
    expect(read(join(s.lAi, 'knowledge', 'b.md'))).toBe('B\n');
    expect(gitIn(s.laneDir, 'status', '--porcelain')).toContain('.ai/knowledge/a.md');
  });

  it('copies a lane change (e.g. pulled from main) into the container', async () => {
    const s = await synced();
    put(s.lAi, 'knowledge/a.md', 'from main\n');
    const r = await s.sync();
    expect(r.toContainer).toEqual(['knowledge/a.md']);
    expect(read(join(s.cAi, 'knowledge', 'a.md'))).toBe('from main\n');
  });

  it('propagates deletions from either side', async () => {
    const s = await synced();
    put(s.cAi, 'knowledge/gone.md', 'G\n');
    await s.sync();
    rmSync(join(s.cAi, 'knowledge', 'gone.md'));
    const r = await s.sync();
    expect(r.deleted.lane).toEqual(['knowledge/gone.md']);
    expect(existsSync(join(s.lAi, 'knowledge', 'gone.md'))).toBe(false);
    rmSync(join(s.lAi, 'knowledge', 'a.md'));
    expect((await s.sync()).deleted.container).toEqual(['knowledge/a.md']);
    expect(existsSync(join(s.cAi, 'knowledge', 'a.md'))).toBe(false);
  });

  it('leaves a conflict untouched on both sides, applies the rest, and exits 3', async () => {
    const s = await synced();
    put(s.cAi, 'knowledge/a.md', 'container\n');
    put(s.lAi, 'knowledge/a.md', 'lane\n');
    put(s.cAi, 'knowledge/b.md', 'B\n');
    const err = await s.sync().catch((e) => e);
    expect(err).toBeInstanceOf(BlockedError);
    expect(err.message).toContain('knowledge/a.md');
    expect(err.message).toContain('laines ai sync lane_1');
    expect(read(join(s.cAi, 'knowledge', 'a.md'))).toBe('container\n');
    expect(read(join(s.lAi, 'knowledge', 'a.md'))).toBe('lane\n');
    expect(read(join(s.lAi, 'knowledge', 'b.md'))).toBe('B\n');
    put(s.lAi, 'knowledge/a.md', 'container\n');
    expect((await s.sync()).conflicts).toEqual([]);
  });

  it('is a no-op the second time, and on a dry run', async () => {
    const s = await synced();
    put(s.cAi, 'knowledge/b.md', 'B\n');
    expect(await s.sync({ dryRun: true })).toMatchObject({ dryRun: true, toLane: ['knowledge/b.md'] });
    expect(existsSync(join(s.lAi, 'knowledge', 'b.md'))).toBe(false);
    await s.sync();
    const board = read(join(s.container, '.ai', 'context', 'LANES_BOARD.md'));
    const again = await s.sync();
    expect(again).toMatchObject({ toLane: [], toContainer: [], conflicts: [] });
    expect(read(join(s.container, '.ai', 'context', 'LANES_BOARD.md'))).toBe(board);
  });

  it('never moves excluded paths or follows symlinks', async () => {
    const s = await synced();
    put(s.cAi, 'knowledge/_draft.md', 'D\n');
    put(s.cAi, 'plans/x.md', 'P\n');
    symlinkSync(join(s.root, 'my-app.git'), join(s.cAi, 'knowledge', 'link'));
    const r = await s.sync();
    expect(r.refused).toEqual(['knowledge/link']);
    for (const rel of ['knowledge/_draft.md', 'plans/x.md', 'knowledge/link']) expect(existsSync(join(s.lAi, rel)), rel).toBe(false);
  });

  it('does nothing for a repository that does not commit .ai/', async () => {
    const s = await setupContainer();
    await invoke('create', { container: s.container }, s.deps);
    const r = await invoke('ai sync', { lane: 'lane_1', container: s.container }, s.deps);
    expect(r).toMatchObject({ applies: false });
    expect(r.note).toContain('does not commit .ai/');
  });

  it('refuses a lane with a merge in progress', async () => {
    const s = await synced();
    writeFileSync(join(s.laneDir, '.git', 'MERGE_HEAD'), 'x\n');
    await expect(s.sync()).rejects.toMatchObject({ exitCode: 3 });
  });

  it('is gated by the aiSync capability and works over MCP and the CLI', async () => {
    const s = await synced();
    put(s.cAi, 'knowledge/b.md', 'B\n');
    const m = await connectMcp(s.deps, { container: s.container });
    const r = await m.call('laines_ai_sync', { lane: 'lane_1' });
    expect(r.structuredContent).toMatchObject({ toLane: ['knowledge/b.md'] });
    await m.close();
    const cli = await runCli(['ai', 'sync', 'lane_1', '--container', s.container, '--format', 'table'], s.deps);
    expect(cli.code).toBe(0);
    expect(cli.stdout).toContain('0 to the lane, 0 to the container');
    setConfig(s.container, (c) => { c.capabilities.aiSync = false; });
    expect((await runCli(['ai', 'sync', 'lane_1', '--container', s.container], s.deps)).code).toBe(4);
    expect(readLanes(loadContainer({ container: s.container }, s.deps)).lanes.lane_1.state).toBe('active');
  });

  describe('per-lane base', () => {
    // A container seeded from a remote committing .ai/knowledge/a.md, with lane_1 and lane_2 created.
    async function twoLanes() {
      const s = await setupContainer({ files: { 'README.md': '# app\n', '.ai/knowledge/a.md': 'A\n' } });
      const l1 = await invoke('create', { container: s.container }, s.deps);
      const l2 = await invoke('create', { container: s.container }, s.deps);
      const sync = (lane, opts = {}) => invoke('ai sync', { lane, container: s.container, ...opts }, s.deps);
      return { ...s, sync, cAi: join(s.container, '.ai'), l1: join(l1.path, '.ai'), l2: join(l2.path, '.ai') };
    }
    const synced = (ai) => syncedState(ai).files;

    it('a second lane that is behind never deletes from the container', async () => {
      const s = await twoLanes();
      const before = synced(s.cAi);
      const r1 = await s.sync('lane_1');
      expect(r1.toLane.length).toBeGreaterThan(0);
      expect(r1.deleted.container).toEqual([]);
      const r2 = await s.sync('lane_2');
      expect(r2).toMatchObject({ toContainer: [], deleted: { container: [] }, conflicts: [] });
      expect(synced(s.cAi)).toEqual(before);
      expect(existsSync(join(s.cAi, '.gitignore'))).toBe(true);
      expect(synced(s.l2)).toEqual(before);
    });

    it('a container edit synced to one lane still reaches a lane that is behind', async () => {
      const s = await twoLanes();
      put(s.cAi, 'knowledge/a.md', 'A2\n');
      await s.sync('lane_1');
      const r2 = await s.sync('lane_2');
      expect(r2.conflicts).toEqual([]);
      expect(r2.toLane).toContain('knowledge/a.md');
      expect(read(join(s.cAi, 'knowledge', 'a.md'))).toBe('A2\n');
      expect(read(join(s.l2, 'knowledge', 'a.md'))).toBe('A2\n');
    });

    it('a lane that pulled a deletion still propagates it to the container', async () => {
      const s = await twoLanes();
      rmSync(join(s.l2, 'knowledge', 'a.md'));
      const r2 = await s.sync('lane_2');
      expect(r2.deleted.container).toEqual(['knowledge/a.md']);
      expect(existsSync(join(s.cAi, 'knowledge', 'a.md'))).toBe(false);
    });

    it('create drops a stale entry for a repository without .ai/, and a failed create leaves none', async () => {
      const plain = await setupContainer();
      const paths = loadContainer({ container: plain.container }, plain.deps).paths;
      writeAiBase(paths, 'lane_1', { 'knowledge/old.md': `sha256:${'0'.repeat(64)}` });
      await invoke('create', { container: plain.container }, plain.deps);
      expect(readAiBase(paths, 'lane_1')).toEqual({});

      const s = await setupContainer({ files: { 'README.md': '# app\n', '.ai/knowledge/a.md': 'A\n' } });
      const git = (args, o) => (args[0] === 'rev-parse' && args[1] === '--git-path' ? { status: 1, stdout: '', stderr: 'fatal: broke' } : s.deps.git(args, o));
      await expect(invoke('create', { container: s.container }, { ...s.deps, git })).rejects.toThrow(/broke/);
      expect(existsSync(join(s.container, 'lane_1'))).toBe(false);
      expect(readAiBases(loadContainer({ container: s.container }, s.deps).paths)).toEqual({});
    });

    it('records the base per lane, and teardown drops the lane entry', async () => {
      const s = await twoLanes();
      const paths = loadContainer({ container: s.container }, s.deps).paths;
      expect(Object.keys(readAiBase(paths, 'lane_1'))).toEqual(['knowledge/a.md']);
      expect(Object.keys(readAiBase(paths, 'lane_2'))).toEqual(['knowledge/a.md']);
      expect(readAiBase(paths, 'lane_9')).toEqual({});
      await s.sync('lane_1');
      expect(Object.keys(readAiBase(paths, 'lane_1')).length).toBeGreaterThan(1);
      expect(Object.keys(readAiBase(paths, 'lane_2'))).toEqual(['knowledge/a.md']);
      await invoke('teardown', { lane: 'lane_2', container: s.container }, s.deps);
      expect(readAiBase(paths, 'lane_2')).toEqual({});
      expect(Object.keys(JSON.parse(read(join(s.container, '.laines', 'ai-sync.json'))).lanes)).toEqual(['lane_1']);
    });
  });
});

