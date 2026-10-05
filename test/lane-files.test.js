import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  laneEnv, laneExcludes, writeLaneFiles, isTracked, untrackedEntries, EXCLUDE_BEGIN, commitsUnder,
} from '../src/lib/lane-files.js';
import { buildConfig } from '../src/config.js';
import { containerPaths } from '../src/lib/paths.js';
import { denyRules } from '../src/lib/agent-files.js';
import { GitError } from '../src/lib/errors.js';
import { tmp, cleanupTmp, testDeps, gitIn, makeRemote } from './helpers.js';

afterEach(cleanupTmp);

function setup({ files, agents = ['claude', 'codex'] } = {}) {
  const root = tmp();
  const remote = makeRemote(root, { files });
  const container = join(root, 'c');
  mkdirSync(container);
  const laneDir = join(container, 'lane_2');
  gitIn(root, 'clone', '-q', remote, laneDir);
  const config = buildConfig({ repoName: 'my-app', remote, defaultBranch: 'main', agents });
  const ctx = { root: container, paths: containerPaths(container), id: 'my-app', config, portRange: [20000, 20199] };
  return { ctx, deps: testDeps(root), lane: { name: 'lane_2', number: 2, laneDir, branch: 'main', ports: [20010, 20019] } };
}

describe('commitsUnder', () => {
  it('is true only when the repository tracks something under the directory', () => {
    const { deps, lane } = setup({ files: { 'README.md': 'x\n', '.ai/plans/a.md': 'p\n' } });
    expect(commitsUnder(deps, lane.laneDir, '.ai/plans')).toBe(true);
    expect(commitsUnder(deps, lane.laneDir, '.ai/context')).toBe(false);
  });
});

describe('laneEnv', () => {
  it('writes every variable, quoted so paths with spaces and shell characters survive source', () => {
    const env = laneEnv({ lane: 'lane_2', number: 2, containerId: 'my-app', laneDir: '/tmp/my lanes/lane_2', containerDir: '/tmp/my lanes', ports: [20010, 20019], branch: 'feat/$x' });
    expect(env).toContain('LANE_SUFFIX="_my_app_l2"');
    expect(env).toContain('COMPOSE_PROJECT_NAME="my-app-l2"');
    expect(env).toContain('PORT="20010"');
    expect(env).toContain('LANE_PORT_COUNT="10"');
    expect(env).toContain('LANE_ID="my-app/lane_2"');
    expect(env).toContain('LANE_ENV_FILE="/tmp/my lanes/lane_2/.laines.env"');
    expect(env).toContain('LANE_BRANCH="feat/\\$x"');
    const out = execFileSync('sh', ['-c', `set -a; . /dev/stdin; printf '%s|%s' "$LANE_DIR" "$LANE_BRANCH"`], { input: env, encoding: 'utf8' });
    expect(out).toBe('/tmp/my lanes/lane_2|feat/$x');
  });

  it("uses the lane's own compose project name when it has one", () => {
    const base = { lane: 'lane_1', number: 1, containerId: 'my-app', laneDir: '/t/lane_1', containerDir: '/t', ports: [20000, 20009], branch: 'main' };
    expect(laneEnv({ ...base, compose: 'myapp' })).toContain('COMPOSE_PROJECT_NAME="myapp"');
    expect(laneEnv(base)).toContain('COMPOSE_PROJECT_NAME="my-app-l1"');
  });
});

describe('writeLaneFiles', () => {
  it('writes lane-local files hidden from git, with deny rules and plansDirectory', () => {
    const { ctx, deps, lane } = setup();
    const r = writeLaneFiles(ctx, deps, lane);
    expect(r.skipped).toEqual([]);
    for (const f of ['.ai/.lane.json', '.ai/README.md', '.ai/context/README.md', '.ai/plans/README.md', '.laines.env', 'CLAUDE.local.md', 'AGENTS.md', '.claude/settings.local.json']) {
      expect(existsSync(join(lane.laneDir, f)), f).toBe(true);
      expect(r.written).toContain(f);
    }
    expect(gitIn(lane.laneDir, 'status', '--porcelain')).toBe('');
    expect(JSON.parse(readFileSync(join(lane.laneDir, '.ai', '.lane.json'), 'utf8'))).toEqual({ lane: 'lane_2', number: 2, containerId: 'my-app', container: ctx.root });
    expect(readFileSync(join(lane.laneDir, '.ai', 'README.md'), 'utf8')).toContain(`${ctx.root}/.ai/`);
    expect(readFileSync(join(lane.laneDir, 'CLAUDE.local.md'), 'utf8')).toContain('Ports: 20010–20019');
    const settings = JSON.parse(readFileSync(join(lane.laneDir, '.claude', 'settings.local.json'), 'utf8'));
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(denyRules()));
    expect(settings.plansDirectory).toBe('.ai/plans');
  });

  it('is idempotent: one exclude block, no duplicate deny rules', () => {
    const { ctx, deps, lane } = setup();
    writeLaneFiles(ctx, deps, lane);
    writeLaneFiles(ctx, deps, lane);
    const exclude = readFileSync(join(lane.laneDir, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split(EXCLUDE_BEGIN)).toHaveLength(2);
    const settings = JSON.parse(readFileSync(join(lane.laneDir, '.claude', 'settings.local.json'), 'utf8'));
    expect(settings.permissions.deny).toHaveLength(denyRules().length);
  });

  it('never overwrites files the repository tracks, and reports them', () => {
    const { ctx, deps, lane } = setup({ files: { 'README.md': 'x\n', '.ai/README.md': 'project ai readme\n', '.ai/plans/README.md': 'project plans\n', 'AGENTS.md': 'project agents\n' } });
    const r = writeLaneFiles(ctx, deps, lane);
    expect(r.skipped.map((s) => s.file).sort()).toEqual(['.ai/README.md', '.ai/plans/README.md', 'AGENTS.md']);
    expect(readFileSync(join(lane.laneDir, '.ai', 'README.md'), 'utf8')).toBe('project ai readme\n');
    expect(readFileSync(join(lane.laneDir, 'AGENTS.md'), 'utf8')).toBe('project agents\n');
    expect(gitIn(lane.laneDir, 'status', '--porcelain')).toBe('');
    expect(isTracked(deps, lane.laneDir, '.ai/plans/README.md')).toBe(true);
    expect(isTracked(deps, lane.laneDir, '.ai/context/README.md')).toBe(false);
    expect(untrackedEntries(deps, lane.laneDir, '.ai/plans')).toEqual([]);
    expect(untrackedEntries(deps, lane.laneDir, '.ai/context')).toEqual(['README.md']);
  });

  it('the exclude block lists only files the repository does not track', () => {
    const { ctx, deps, lane } = setup({ files: { 'README.md': 'x\n', 'AGENTS.md': 'a\n', '.ai/README.md': 'r\n' } });
    writeLaneFiles(ctx, deps, lane);
    const exclude = readFileSync(join(lane.laneDir, '.git', 'info', 'exclude'), 'utf8').split('\n');
    expect(exclude).not.toContain('/AGENTS.md');
    expect(exclude).not.toContain('/.ai/README.md');
    for (const keep of ['/.ai/context/', '/*.pre-laines*', '/GEMINI.md']) expect(exclude).toContain(keep);
    expect(laneExcludes(deps, lane.laneDir)).toEqual(expect.not.arrayContaining(['/AGENTS.md', '/.ai/README.md']));
  });

  it('a repository tracking .ai/plans/ keeps new plans visible; laines hides only its own README', () => {
    const { ctx, deps, lane } = setup({ files: { 'README.md': 'x\n', '.ai/plans/a.md': 'plan\n' } });
    writeLaneFiles(ctx, deps, lane);
    const exclude = readFileSync(join(lane.laneDir, '.git', 'info', 'exclude'), 'utf8').split('\n');
    expect(exclude).toContain('/.ai/plans/README.md');
    expect(exclude).not.toContain('/.ai/plans/');
    expect(exclude).toContain('/.ai/context/');
    writeFileSync(join(lane.laneDir, '.ai', 'plans', 'new.md'), 'n\n');
    const ignored = (rel) => spawnSync('git', ['check-ignore', '-q', rel], { cwd: lane.laneDir }).status === 0;
    expect(ignored('.ai/plans/new.md')).toBe(false);
    expect(ignored('.ai/plans/README.md')).toBe(true);
  });

  it('a repository tracking .ai/context/ and its README leaves neither in the block', () => {
    const { ctx, deps, lane } = setup({ files: { 'README.md': 'x\n', '.ai/context/README.md': 'c\n' } });
    writeLaneFiles(ctx, deps, lane);
    const exclude = readFileSync(join(lane.laneDir, '.git', 'info', 'exclude'), 'utf8').split('\n');
    expect(exclude).not.toContain('/.ai/context/');
    expect(exclude).not.toContain('/.ai/context/README.md');
    expect(exclude).toContain('/.ai/plans/');
  });

  it('a repository tracking nothing under .ai/ gets the directory entries', () => {
    const { deps, lane } = setup();
    expect(laneExcludes(deps, lane.laneDir)).toEqual(expect.arrayContaining(['/.ai/context/', '/.ai/plans/']));
  });

  it('asks git once for the whole block', () => {
    const { deps, lane } = setup();
    const calls = [];
    const counting = { ...deps, git: (args, o) => { calls.push(args[0]); return deps.git(args, o); } };
    laneExcludes(counting, lane.laneDir);
    expect(calls.filter((c) => c === 'ls-files')).toHaveLength(1);
  });

  it('treats tracked files with non-ASCII names as tracked', () => {
    const { deps, lane } = setup({ files: { 'README.md': 'x\n', '.ai/plans/résumé.md': 'p\n' } });
    expect(untrackedEntries(deps, lane.laneDir, '.ai/plans')).not.toContain('résumé.md');
    expect(untrackedEntries(deps, lane.laneDir, '.ai/plans')).toEqual([]);
  });

  it('isTracked throws GitError outside a git repository instead of reading as untracked', () => {
    const dir = tmp();
    expect(() => isTracked(testDeps(dir), dir, 'x')).toThrow(GitError);
  });
});
