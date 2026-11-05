import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runCreate } from '../src/commands/create.js';
import { runRefresh } from '../src/commands/refresh.js';
import { runTeardown } from '../src/commands/teardown.js';
import { loadContainer } from '../src/lib/container.js';
import { readLanes } from '../src/lib/lanes-store.js';
import { tmp, cleanupTmp, setupContainer, gitIn } from './helpers.js';

afterEach(cleanupTmp);

// Commits each { path: target } as a symlink in the fixture remote (via its seed clone) and pushes it.
function pushLinks(s, links) {
  const seed = join(s.root, 'seed');
  for (const [rel, target] of Object.entries(links)) {
    mkdirSync(dirname(join(seed, rel)), { recursive: true });
    symlinkSync(target, join(seed, rel));
  }
  gitIn(seed, 'add', '-A');
  gitIn(seed, 'commit', '-q', '-m', 'links');
  gitIn(seed, 'push', '-q', s.remote, 'main');
}

// A directory outside the container holding a file that must survive.
function outsideDir() {
  const dir = tmp('laines-outside-');
  writeFileSync(join(dir, 'precious.txt'), 'keep\n');
  return dir;
}

const laneState = (s) => readLanes(loadContainer({ container: s.container }, s.deps)).lanes.lane_1;

// A clean lane whose clone then fast-forwards onto a commit with the given symlinks: nothing unpushed.
async function linkedLane(links, { remove = ['.ai'] } = {}) {
  const s = await setupContainer();
  const l = await runCreate({ container: s.container }, s.deps);
  pushLinks(s, links);
  for (const rel of remove) rmSync(join(l.path, rel), { recursive: true, force: true });
  gitIn(l.path, 'pull', '-q', '--ff-only');
  return { ...s, dir: l.path };
}

describe('lane files refuse committed symlinks', () => {
  it('create refuses a repository that commits .ai/context as a symlink out of the lane', async () => {
    const s = await setupContainer();
    const outside = outsideDir();
    pushLinks(s, { '.ai/context': outside });
    await expect(runCreate({ container: s.container }, s.deps)).rejects.toThrow(/symbolic link/);
    expect(readdirSync(outside)).toEqual(['precious.txt']);
  });

  it('refresh refuses a lane whose .ai/context became a symlink out of the lane', async () => {
    const outside = outsideDir();
    const s = await linkedLane({ '.ai/context': outside });
    await expect(runRefresh({ lane: 'lane_1', container: s.container }, s.deps)).rejects.toThrow(/symbolic link/);
    expect(readdirSync(outside)).toEqual(['precious.txt']);
  });

  it('create refuses a repository that commits .ai -> ../.ai, leaving the container .ai alone', async () => {
    const s = await setupContainer();
    const readme = readFileSync(join(s.container, '.ai', 'README.md'), 'utf8');
    pushLinks(s, { '.ai': '../.ai' });
    await expect(runCreate({ container: s.container }, s.deps)).rejects.toThrow(/symbolic link/);
    expect(readFileSync(join(s.container, '.ai', 'README.md'), 'utf8')).toBe(readme);
    expect(existsSync(join(s.container, '.ai', '.lane.json'))).toBe(false);
  });
});

describe('teardown refuses committed symlinks', () => {
  it('refuses .ai/context and .ai/plans symlinked out of the lane, touching nothing', async () => {
    const ctxDir = outsideDir();
    const plansDir = outsideDir();
    const s = await linkedLane({ '.ai/context': ctxDir, '.ai/plans': plansDir });
    expect(gitIn(s.dir, 'status', '--porcelain')).toBe('');
    await expect(runTeardown({ lane: 'lane_1', container: s.container }, s.deps)).rejects.toThrow(/symbolic link/);
    expect(readdirSync(ctxDir)).toEqual(['precious.txt']);
    expect(readdirSync(plansDir)).toEqual(['precious.txt']);
    expect(existsSync(join(s.container, '.ai', 'archive', '2026-09-29_lane_1'))).toBe(false);
    expect(laneState(s).state).toBe('active');
    expect(existsSync(s.dir)).toBe(true);
  });

  it('refuses .ai -> ../.ai, leaving the container shared context and plans alone', async () => {
    const s = await linkedLane({ '.ai': '../.ai' });
    writeFileSync(join(s.container, '.ai', 'context', 'shared.md'), 'ctx\n');
    writeFileSync(join(s.container, '.ai', 'plans', 'shared.md'), 'plan\n');
    await expect(runTeardown({ lane: 'lane_1', keepDir: true, container: s.container }, s.deps)).rejects.toThrow(/symbolic link/);
    expect(readFileSync(join(s.container, '.ai', 'context', 'shared.md'), 'utf8')).toBe('ctx\n');
    expect(readFileSync(join(s.container, '.ai', 'plans', 'shared.md'), 'utf8')).toBe('plan\n');
    expect(laneState(s).state).toBe('active');
  });

  it('refuses a dry run too, so the MCP confirmation never reads through the link', async () => {
    const s = await linkedLane({ '.ai/plans': outsideDir() });
    await expect(runTeardown({ lane: 'lane_1', dryRun: true, container: s.container }, s.deps)).rejects.toThrow(/symbolic link/);
  });
});

describe('lane files refuse to write through a file symlink', () => {
  it('refresh refuses a lane whose .laines.env is a symlink out of the lane', async () => {
    const s = await setupContainer();
    const l = await runCreate({ container: s.container }, s.deps);
    const outside = outsideDir();
    rmSync(join(l.path, '.laines.env'));
    symlinkSync(join(outside, 'precious.txt'), join(l.path, '.laines.env'));
    await expect(runRefresh({ lane: 'lane_1', container: s.container }, s.deps)).rejects.toThrow(/symbolic link/);
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('keep\n');
  });

  // On a case-insensitive disk Claude.local.md is the file CLAUDE.local.md names: it counts as tracked.
  const probe = tmp('laines-case-');
  writeFileSync(join(probe, 'a'), '');
  const caseInsensitive = existsSync(join(probe, 'A'));
  it.runIf(caseInsensitive)('create skips CLAUDE.local.md when the repository commits it under another case as a symlink', async () => {
    const s = await setupContainer();
    const outside = outsideDir();
    pushLinks(s, { 'Claude.local.md': join(outside, 'precious.txt') });
    const l = await runCreate({ container: s.container }, s.deps);
    expect(l.warnings).toContain('CLAUDE.local.md not written: tracked by the repository');
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('keep\n');
  });
});
