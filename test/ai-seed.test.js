import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { seedFromRemote } from '../src/lib/ai-seed.js';
import { execFileSync } from 'node:child_process';
import { tmp, cleanupTmp, testDeps, setupContainer, makeRemote, runCli } from './helpers.js';

afterEach(cleanupTmp);

// testDeps puts the machine config dir at <root>/config, so this only sees this test's temp dirs.
const seedDirs = (root) => (existsSync(join(root, 'config')) ? readdirSync(join(root, 'config')).filter((d) => d.startsWith('seed-')) : []);

describe('seedFromRemote', () => {
  it("copies the default branch's whole .ai/", async () => {
    const root = tmp();
    const remote = makeRemote(root, { files: { 'README.md': '#\n', '.ai/knowledge/a.md': 'A\n', '.ai/context/x.md': 'X\n' } });
    const dest = join(root, 'out', '.ai');
    const r = await seedFromRemote(testDeps(root), remote, 'main', dest);
    expect(r).toMatchObject({ seeded: true, files: 2, warning: null });
    expect(r).not.toHaveProperty('base');
    expect(readFileSync(join(dest, 'knowledge', 'a.md'), 'utf8')).toBe('A\n');
    expect(readFileSync(join(dest, 'context', 'x.md'), 'utf8')).toBe('X\n');
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
    expect(seedDirs(root)).toEqual([]);
  });

  it('reports the informative line of a multi-line git failure', async () => {
    const root = tmp();
    const stderr = "Cloning into 'x'...\nssh: Could not resolve hostname nope: nodename nor servname provided\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n";
    const deps = testDeps(root, { gitAsync: async () => ({ status: 128, stdout: '', stderr, error: undefined }) });
    const r = await seedFromRemote(deps, 'git@nope:o/r.git', 'main', join(root, 'out', '.ai'));
    expect(r.warning).toContain('ssh: Could not resolve hostname');
    expect(r.warning).not.toContain('and the repository exists');
  });

  it('reports symlinks it skipped', async () => {
    const root = tmp();
    const seed = join(root, 'seed');
    const remote = makeRemote(root, { files: { '.ai/knowledge/a.md': 'A\n' } });
    symlinkSync('a.md', join(seed, '.ai', 'knowledge', 'link'));
    const g = (...a) => execFileSync('git', ['-C', seed, '-c', 'user.name=T', '-c', 'user.email=t@e.x', ...a]);
    g('add', '-A');
    g('commit', '-q', '-m', 'link');
    g('push', '-q', remote, 'main');
    const r = await seedFromRemote(testDeps(root), remote, 'main', join(root, 'out', '.ai'));
    expect(r.skipped).toEqual(['knowledge/link']);
    expect(existsSync(join(root, 'out', '.ai', 'knowledge', 'link'))).toBe(false);
  });
});

describe('init seeding', () => {
  it("seeds a new container's shared .ai/ from the remote, recording no base until a lane exists", async () => {
    const s = await setupContainer({ files: { 'README.md': '#\n', '.ai/knowledge/a.md': 'A\n' } });
    expect(readFileSync(join(s.container, '.ai', 'knowledge', 'a.md'), 'utf8')).toBe('A\n');
    expect(existsSync(join(s.container, '.ai', 'runbooks', '_lane-management.md'))).toBe(true);
    expect(existsSync(join(s.container, '.laines', 'ai-sync.json'))).toBe(false);
  });

  it('falls back to a fresh layer with a warning when the remote cannot be read', async () => {
    const root = tmp();
    mkdirSync(join(root, 'home'));
    const { runDotAi } = await import('../src/lib/dotai.js');
    const r = await runCli(['init', 'lanes', '--remote', 'git@example.com:org/my-app.git', '--format', 'table'], testDeps(root, { runDotAi }));
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/warning: could not read the remote's \.ai\//);
  });

  it('warns about skipped symlinks and a non-directory .ai in the remote, and --no-seed skips the read', async () => {
    const root = tmp();
    mkdirSync(join(root, 'home'));
    const { runDotAi } = await import('../src/lib/dotai.js');
    const remote = makeRemote(root, { files: { 'real/a.md': 'A\n' } });
    const seed = join(root, 'seed');
    symlinkSync('real', join(seed, '.ai'));
    const g = (...a) => execFileSync('git', ['-C', seed, '-c', 'user.name=T', '-c', 'user.email=t@e.x', ...a]);
    g('add', '-A');
    g('commit', '-q', '-m', 'ai symlink');
    g('push', '-q', remote, 'main');
    const r = await runCli(['init', 'lanes', '--remote', remote, '--format', 'table'], testDeps(root, { runDotAi }));
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\.ai in the remote is not a directory/);
    expect(existsSync(join(root, 'lanes', '.ai', 'runbooks', '_lane-management.md'))).toBe(true);
  });

  it('--no-seed starts fresh without reading the remote', async () => {
    const root = tmp();
    mkdirSync(join(root, 'home'));
    const { runDotAi } = await import('../src/lib/dotai.js');
    const remote = makeRemote(root, { files: { '.ai/knowledge/a.md': 'A\n' } });
    const r = await runCli(['init', 'lanes', '--remote', remote, '--no-seed'], testDeps(root, { runDotAi }));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ai: { seeded: false, files: 0 }, warnings: [] });
    expect(existsSync(join(root, 'lanes', '.ai', 'knowledge', 'a.md'))).toBe(false);
    expect(existsSync(join(root, 'lanes', '.laines', 'ai-sync.json'))).toBe(false);
  });
});
