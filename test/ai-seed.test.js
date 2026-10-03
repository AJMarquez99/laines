import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { seedFromRemote } from '../src/lib/ai-seed.js';
import { readAiBase } from '../src/lib/ai-tree.js';
import { containerPaths } from '../src/lib/paths.js';
import { tmp, cleanupTmp, testDeps, setupContainer, makeRemote, runCli } from './helpers.js';

afterEach(cleanupTmp);

// testDeps puts the machine config dir at <root>/config, so this only sees this test's temp dirs.
const seedDirs = (root) => (existsSync(join(root, 'config')) ? readdirSync(join(root, 'config')).filter((d) => d.startsWith('seed-')) : []);

describe('seedFromRemote', () => {
  it("copies the default branch's .ai/ and returns its synced set as the base", async () => {
    const root = tmp();
    const remote = makeRemote(root, { files: { 'README.md': '#\n', '.ai/knowledge/a.md': 'A\n', '.ai/context/x.md': 'X\n' } });
    const dest = join(root, 'out', '.ai');
    const r = await seedFromRemote(testDeps(root), remote, 'main', dest);
    expect(r).toMatchObject({ seeded: true, files: 2, warning: null });
    expect(Object.keys(r.base)).toEqual(['knowledge/a.md']);
    expect(readFileSync(join(dest, 'knowledge', 'a.md'), 'utf8')).toBe('A\n');
    expect(existsSync(join(root, 'out', 'README.md'))).toBe(false);
    expect(seedDirs(root)).toEqual([]);
  });

  it('reports no seed for a remote without .ai/, and a warning for one it cannot read', async () => {
    const root = tmp();
    const remote = makeRemote(root);
    mkdirSync(join(root, 'out'));
    expect(await seedFromRemote(testDeps(root), remote, 'main', join(root, 'out', '.ai'))).toMatchObject({ seeded: false, warning: null });
    const bad = await seedFromRemote(testDeps(root), join(root, 'missing.git'), 'main', join(root, 'out', '.ai'));
    expect(bad.seeded).toBe(false);
    expect(bad.warning).toMatch(/could not read the remote's \.ai\//);
  });
});

describe('init seeding', () => {
  it("seeds a new container's shared .ai/ from the remote and records the base", async () => {
    const s = await setupContainer({ files: { 'README.md': '#\n', '.ai/knowledge/a.md': 'A\n' } });
    expect(readFileSync(join(s.container, '.ai', 'knowledge', 'a.md'), 'utf8')).toBe('A\n');
    expect(existsSync(join(s.container, '.ai', 'runbooks', 'lane-management.md'))).toBe(true);
    expect(Object.keys(readAiBase(containerPaths(s.container)))).toEqual(['knowledge/a.md']);
  });

  it('falls back to a fresh layer with a warning when the remote cannot be read', async () => {
    const root = tmp();
    mkdirSync(join(root, 'home'));
    const { runDotAi } = await import('../src/lib/dotai.js');
    const r = await runCli(['init', 'lanes', '--remote', 'git@example.com:org/my-app.git', '--format', 'table'], testDeps(root, { runDotAi }));
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/warning: could not read the remote's \.ai\//);
  });
});
