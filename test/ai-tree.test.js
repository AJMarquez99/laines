import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  aiDrift, copyTree, isSynced, planSync, readAiBase, repoCommitsAi, syncedState, walk, writeAiBase,
} from '../src/lib/ai-tree.js';
import { operationInProgress } from '../src/lib/lane-git.js';
import { containerPaths } from '../src/lib/paths.js';
import { checksum } from '../src/lib/hooks.js';
import { BlockedError, MalformedConfigError } from '../src/lib/errors.js';
import { tmp, cleanupTmp, testDeps, gitIn } from './helpers.js';

afterEach(cleanupTmp);

function put(root, rel, text) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

describe('isSynced', () => {
  it('excludes lane-owned, local-only and laines-owned paths', () => {
    for (const rel of ['knowledge/a.md', 'guidelines/README.md', '.gitignore', 'runbooks/deploy.md', 'templates/pr.md']) expect(isSynced(rel), rel).toBe(true);
    for (const rel of ['context/LANES_BOARD.md', 'plans/p.md', 'archive/2026-10-02_board-log.md', 'archive/2026-10-02_lane_1/plans/p.md', '_secrets.md', 'knowledge/_draft.md', '_scratch/x.md', 'README.md', '.lane.json',
      'runbooks/lane-management.md', 'templates/lane-ai-readme.md', 'templates/lane-context-readme.md', 'templates/lane-plans-readme.md', 'templates/lane-local-instructions.md']) {
      expect(isSynced(rel), rel).toBe(false);
    }
  });
});

describe('walk, syncedState and copyTree', () => {
  it('lists files and symlinks without following symlinks', () => {
    const root = tmp();
    const ai = join(root, '.ai');
    put(ai, 'knowledge/a.md', 'A\n');
    put(ai, 'context/h.md', 'H\n');
    put(root, 'outside/secret.md', 'S\n');
    symlinkSync(join(root, 'outside'), join(ai, 'knowledge', 'linked'));
    symlinkSync(join(root, 'outside', 'secret.md'), join(ai, 'guidelines.md'));
    expect(walk(ai)).toEqual({ files: ['context/h.md', 'knowledge/a.md'], symlinks: ['guidelines.md', 'knowledge/linked'] });
    expect(walk(join(root, 'missing'))).toEqual({ files: [], symlinks: [] });
    expect(syncedState(ai)).toEqual({ files: { 'knowledge/a.md': checksum('A\n') }, symlinks: ['guidelines.md', 'knowledge/linked'] });
  });

  it('copies every regular file and skips symlinks', () => {
    const root = tmp();
    const src = join(root, 'src');
    put(src, 'knowledge/a.md', 'A\n');
    put(src, 'context/h.md', 'H\n');
    symlinkSync(join(src, 'knowledge', 'a.md'), join(src, 'link.md'));
    const dest = join(root, 'dest');
    put(dest, 'knowledge/a.md', 'old\n');
    expect(copyTree(src, dest)).toEqual({ copied: ['context/h.md', 'knowledge/a.md'], skippedSymlinks: ['link.md'] });
    expect(readFileSync(join(dest, 'knowledge', 'a.md'), 'utf8')).toBe('A\n');
    expect(walk(dest).symlinks).toEqual([]);
  });

  it('counts drift between two .ai/ trees over the synced set', () => {
    const root = tmp();
    put(root, 'c/knowledge/same.md', 'S\n');
    put(root, 'l/knowledge/same.md', 'S\n');
    put(root, 'c/knowledge/diff.md', '1\n');
    put(root, 'l/knowledge/diff.md', '2\n');
    put(root, 'c/knowledge/only-c.md', 'C\n');
    put(root, 'l/context/ignored.md', 'X\n');
    expect(aiDrift(join(root, 'c'), join(root, 'l'))).toBe(2);
  });

  it('throws BlockedError when walk root is a symlink', () => {
    const root = tmp();
    put(root, 'real/.ai/knowledge/a.md', 'A\n');
    const linkDir = join(root, 'link');
    symlinkSync(join(root, 'real', '.ai'), linkDir);
    expect(() => walk(linkDir)).toThrow(BlockedError);
    expect(() => walk(linkDir)).toThrow(/is a symbolic link: refusing to read through it/);
  });

  it('throws BlockedError when walk root is a dangling symlink', () => {
    const root = tmp();
    const linkDir = join(root, 'dangling');
    symlinkSync('/nonexistent/path', linkDir);
    expect(() => walk(linkDir)).toThrow(BlockedError);
    expect(() => walk(linkDir)).toThrow(/is a symbolic link: refusing to read through it/);
  });

  it('throws BlockedError when copyTree destination has symlinks', () => {
    const root = tmp();
    const src = join(root, 'src');
    put(src, 'knowledge/a.md', 'A\n');
    const dest = join(root, 'dest');
    put(dest, 'knowledge/x.md', 'old\n');
    symlinkSync(join(dest, 'knowledge', 'x.md'), join(dest, 'link.md'));
    expect(() => copyTree(src, dest)).toThrow(BlockedError);
    expect(() => copyTree(src, dest)).toThrow(/destination has symlinks: refusing to write through them/);
    // Ensure no files were copied
    expect(readFileSync(join(dest, 'knowledge', 'x.md'), 'utf8')).toBe('old\n');
  });
});

describe('planSync', () => {
  const A = 'sha256:a'; const B = 'sha256:b'; const C = 'sha256:c';

  it('implements the three-way table, deletions included', () => {
    const plan = planSync({
      container: { same: A, cChanged: B, lChanged: A, both: B, bothSame: C, cDeleted: undefined, cAdded: A, lAdded: undefined },
      lane: { same: A, cChanged: A, lChanged: B, both: C, bothSame: C, cDeleted: A, cAdded: undefined, lAdded: B },
      base: { same: A, cChanged: A, lChanged: A, both: A, bothSame: A, cDeleted: A },
    });
    expect(plan.toLane.sort()).toEqual(['cAdded', 'cChanged', 'cDeleted']);
    expect(plan.toContainer.sort()).toEqual(['lAdded', 'lChanged']);
    expect(plan.conflicts).toEqual(['both']);
    expect(plan.nextBase).toEqual({ same: A, cChanged: B, lChanged: B, both: A, bothSame: C, cAdded: A, lAdded: B });
  });

  it('treats an empty base as a merge: one-sided files move across, files differing on both sides conflict', () => {
    const plan = planSync({ container: { onlyC: A, differ: A }, lane: { onlyL: B, differ: B }, base: {} });
    expect(plan.toLane).toEqual(['onlyC']);
    expect(plan.toContainer).toEqual(['onlyL']);
    expect(plan.conflicts).toEqual(['differ']);
    expect(plan.nextBase).toEqual({ onlyC: A, onlyL: B });
  });

  it('keeps a __proto__ path as data', () => {
    const plan = planSync({ container: JSON.parse('{"__proto__":"sha256:a"}'), lane: {}, base: {} });
    expect(Object.hasOwn(plan.nextBase, '__proto__')).toBe(true);
    expect({}.polluted).toBeUndefined();
  });

  it('places files under symlinked directories into refused bucket, keeping base entries', () => {
    const A = 'sha256:a';
    const plan = planSync({
      container: { 'knowledge/linked': A, 'knowledge/linked/x.md': A },
      lane: { 'knowledge/linked/x.md': A },
      base: { 'knowledge/linked': A, 'knowledge/linked/x.md': A },
      refused: ['knowledge/linked'],
    });
    expect(plan.toLane).toEqual([]);
    expect(plan.toContainer).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.refused.sort()).toEqual(['knowledge/linked', 'knowledge/linked/x.md']);
    expect(plan.nextBase).toEqual({ 'knowledge/linked': A, 'knowledge/linked/x.md': A });
  });
});

describe('ai-sync.json', () => {
  it('reads a missing base as empty, round-trips, and rejects a malformed one', () => {
    const root = tmp();
    const paths = containerPaths(root);
    expect(readAiBase(paths)).toEqual({});
    writeAiBase(paths, { 'knowledge/a.md': checksum('A\n') });
    expect(readAiBase(paths)).toEqual({ 'knowledge/a.md': checksum('A\n') });
    writeFileSync(join(paths.laines, 'ai-sync.json'), JSON.stringify({ version: 1, base: { x: 42 } }));
    expect(() => readAiBase(paths)).toThrow(MalformedConfigError);
  });
});

describe('repository state', () => {
  it('knows whether a repository commits .ai/ and whether an operation is in progress', () => {
    const repo = tmp();
    gitIn(repo, 'init', '-q', '-b', 'main');
    const deps = testDeps(repo);
    put(repo, 'README.md', '#\n');
    put(repo, '.ai/plans/p.md', 'P\n');
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-q', '-m', 'init');
    expect(repoCommitsAi(deps, repo)).toBe(false);
    put(repo, '.ai/knowledge/a.md', 'A\n');
    expect(repoCommitsAi(deps, repo)).toBe(false);
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-q', '-m', 'ai');
    expect(repoCommitsAi(deps, repo)).toBe(true);
    expect(operationInProgress(deps, repo)).toBe(null);
    writeFileSync(join(repo, '.git', 'MERGE_HEAD'), 'x\n');
    expect(operationInProgress(deps, repo)).toBe('MERGE_HEAD');
  });

  it('detects operations in linked worktrees (git rev-parse --git-path)', () => {
    const repo = tmp();
    gitIn(repo, 'init', '-q', '-b', 'main');
    put(repo, 'README.md', '#\n');
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-q', '-m', 'init');
    // Create a linked worktree
    const worktree = join(repo, 'linked');
    gitIn(repo, 'worktree', 'add', worktree, 'HEAD');
    const depsWorktree = testDeps(worktree);
    // Get the absolute git-path for MERGE_HEAD in the worktree
    const gitPath = gitIn(worktree, 'rev-parse', '--git-path', 'MERGE_HEAD').trim();
    expect(operationInProgress(depsWorktree, worktree)).toBe(null);
    mkdirSync(dirname(gitPath), { recursive: true });
    writeFileSync(gitPath, 'x\n');
    expect(operationInProgress(depsWorktree, worktree)).toBe('MERGE_HEAD');
  });
});
