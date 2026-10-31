import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  aiDrift, copyOrDelete, copyTree, isSynced, planSync, readAiBase, readAiBases, realAi, repoCommitsAi, syncedState, walk, writeAiBase,
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
      'runbooks/lane-management.md', 'templates/lane-ai-readme.md', 'templates/lane-context-readme.md', 'templates/lane-plans-readme.md', 'templates/lane-local-instructions.md',
      'runbooks/_lane-management.md', 'templates/_lane-ai-readme.md', 'templates/_lane-context-readme.md', 'templates/_lane-plans-readme.md', 'templates/_lane-local-instructions.md', 'runbooks/_README.md', 'templates/_README.md']) {
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
    expect(syncedState(ai)).toEqual({ files: { 'knowledge/a.md': checksum('A\n') }, names: { 'knowledge/a.md': 'knowledge/a.md' }, symlinks: ['guidelines.md', 'knowledge/linked'] });
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

describe('Unicode normalisation: one file, one key', () => {
  const NFC = 'knowledge/caf\u00e9.md';
  const NFD = 'knowledge/cafe\u0301.md';
  // macOS file systems treat the two forms as one name; Linux ones keep both.
  const probe = tmp('laines-nfc-');
  writeFileSync(join(probe, 'caf\u00e9'), '');
  const formInsensitive = existsSync(join(probe, 'cafe\u0301'));

  it('syncedState keys an NFD name by its NFC form and remembers the name on disk', () => {
    const ai = join(tmp(), '.ai');
    put(ai, NFD, 'A\n');
    const s = syncedState(ai);
    expect(s.files).toEqual({ [NFC]: checksum('A\n') });
    expect(s.names[NFC].normalize('NFC')).toBe(NFC);
    expect(existsSync(join(ai, s.names[NFC]))).toBe(true);
  });

  it('planSync sees an NFD lane name and its NFC container twin as one file, and reads an NFD base key', () => {
    const root = tmp();
    put(root, `c/${NFC}`, 'A\n');
    put(root, `l/${NFD}`, 'A\n');
    const c = syncedState(join(root, 'c'));
    const l = syncedState(join(root, 'l'));
    expect(planSync({ container: c.files, lane: l.files, base: {} })).toMatchObject({ toLane: [], toContainer: [], conflicts: [], nextBase: { [NFC]: checksum('A\n') } });
    const plan = planSync({ container: { [NFC]: 'sha256:a' }, lane: { [NFD]: 'sha256:b' }, base: { [NFD]: 'sha256:a' } });
    expect(plan).toMatchObject({ toLane: [], toContainer: [NFC], conflicts: [] });
  });

  it('copyOrDelete writes and deletes through the name on disk, never adding a twin', () => {
    const root = tmp();
    put(root, `c/${NFC}`, 'new\n');
    put(root, `l/${NFD}`, 'old\n');
    const side = (d) => ({ dir: join(root, d), root: realAi(join(root, d)), names: syncedState(join(root, d)).names });
    copyOrDelete(side('c'), side('l'), NFC);
    expect(walk(join(root, 'l')).files).toHaveLength(1);
    expect(readFileSync(join(root, 'l', side('l').names[NFC]), 'utf8')).toBe('new\n');
    copyOrDelete({ dir: join(root, 'x'), root: join(root, 'x'), names: {} }, side('l'), NFC);
    expect(walk(join(root, 'l')).files).toEqual([]);
  });

  it.runIf(!formInsensitive)('syncedState refuses two names that differ only in Unicode form', () => {
    const ai = join(tmp(), '.ai');
    put(ai, NFC, 'A\n');
    put(ai, NFD, 'B\n');
    expect(() => syncedState(ai)).toThrow(BlockedError);
    expect(() => syncedState(ai)).toThrow(/one name in two Unicode forms/);
  });
});

describe('copyOrDelete after a symlink swap between planning and writing', () => {
  // The container's knowledge/a.md changed; the lane's is the base, so the plan copies it to the lane.
  function planned() {
    const root = tmp();
    put(root, 'c/.ai/knowledge/a.md', 'new\n');
    put(root, 'l/.ai/knowledge/a.md', 'old\n');
    put(root, 'l/.ai/knowledge/gone.md', 'G\n');
    put(root, 'outside/knowledge/a.md', 'outside\n');
    put(root, 'outside/knowledge/gone.md', 'outside\n');
    const side = (d) => ({ dir: join(root, d, '.ai'), root: realAi(join(root, d, '.ai')), names: syncedState(join(root, d, '.ai')).names });
    const c = side('c');
    const l = side('l');
    const plan = planSync({ container: syncedState(c.dir).files, lane: syncedState(l.dir).files, base: syncedState(l.dir).files });
    expect(plan.toLane).toEqual(['knowledge/a.md', 'knowledge/gone.md']);
    const outside = (rel) => readFileSync(join(root, 'outside', rel), 'utf8');
    return { root, c, l, plan, outside };
  }

  it('writes normally when nothing was swapped', () => {
    const s = planned();
    for (const rel of s.plan.toLane) copyOrDelete(s.c, s.l, rel);
    expect(readFileSync(join(s.l.dir, 'knowledge', 'a.md'), 'utf8')).toBe('new\n');
    expect(existsSync(join(s.l.dir, 'knowledge', 'gone.md'))).toBe(false);
  });

  it('refuses to write or delete through a lane .ai/<dir> swapped for a symlink', () => {
    const s = planned();
    renameSync(join(s.l.dir, 'knowledge'), join(s.root, 'moved'));
    symlinkSync(join(s.root, 'outside', 'knowledge'), join(s.l.dir, 'knowledge'));
    for (const rel of s.plan.toLane) {
      expect(() => copyOrDelete(s.c, s.l, rel), rel).toThrow(BlockedError);
      expect(() => copyOrDelete(s.c, s.l, rel), rel).toThrow(/not where it sits in .* refusing to write or delete through it/);
    }
    expect(s.outside('knowledge/a.md')).toBe('outside\n');
    expect(s.outside('knowledge/gone.md')).toBe('outside\n');
  });

  it('refuses a lane .ai/<dir> swapped for a symlink to an excluded folder inside .ai/', () => {
    const s = planned();
    put(s.l.dir, 'context/a.md', 'context\n');
    renameSync(join(s.l.dir, 'knowledge'), join(s.root, 'moved'));
    symlinkSync(join(s.l.dir, 'context'), join(s.l.dir, 'knowledge'));
    expect(() => copyOrDelete(s.c, s.l, 'knowledge/a.md')).toThrow(BlockedError);
    expect(walk(join(s.l.dir, 'context')).files).toEqual(['a.md']);
    expect(readFileSync(join(s.l.dir, 'context', 'a.md'), 'utf8')).toBe('context\n');
  });

  it('refuses to create a directory under a swapped one', () => {
    const s = planned();
    put(s.c.dir, 'knowledge/sub/new.md', 'N\n');
    const c = { ...s.c, names: syncedState(s.c.dir).names };
    renameSync(join(s.l.dir, 'knowledge'), join(s.root, 'moved'));
    symlinkSync(join(s.root, 'outside', 'knowledge'), join(s.l.dir, 'knowledge'));
    expect(() => copyOrDelete(c, s.l, 'knowledge/sub/new.md')).toThrow(BlockedError);
    expect(existsSync(join(s.root, 'outside', 'knowledge', 'sub'))).toBe(false);
  });

  it('refuses when the lane .ai/ itself is swapped for a symlink', () => {
    const s = planned();
    renameSync(s.l.dir, join(s.root, 'moved'));
    symlinkSync(join(s.root, 'outside'), s.l.dir);
    expect(() => copyOrDelete(s.c, s.l, 'knowledge/a.md')).toThrow(BlockedError);
    expect(s.outside('knowledge/a.md')).toBe('outside\n');
  });

  it('refuses to read through a lane file swapped for a symlink', () => {
    const s = planned();
    put(s.root, 'outside/secret.md', 'S\n');
    renameSync(join(s.l.dir, 'knowledge', 'a.md'), join(s.root, 'moved.md'));
    symlinkSync(join(s.root, 'outside', 'secret.md'), join(s.l.dir, 'knowledge', 'a.md'));
    expect(() => copyOrDelete(s.l, s.c, 'knowledge/a.md')).toThrow(/is a symbolic link: refusing to sync through it/);
    expect(readFileSync(join(s.c.dir, 'knowledge', 'a.md'), 'utf8')).toBe('new\n');
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
  it('keeps one base per lane: missing is empty, writes touch one lane, v1 is no base, malformed throws', () => {
    const root = tmp();
    const paths = containerPaths(root);
    const file = join(paths.laines, 'ai-sync.json');
    expect(readAiBase(paths, 'lane_1')).toEqual({});
    writeAiBase(paths, 'lane_1', null);
    expect(existsSync(file)).toBe(false);
    writeAiBase(paths, 'lane_1', { 'knowledge/a.md': checksum('A\n') });
    writeAiBase(paths, 'lane_2', { 'knowledge/b.md': checksum('B\n') });
    expect(readAiBase(paths, 'lane_1')).toEqual({ 'knowledge/a.md': checksum('A\n') });
    expect(readAiBase(paths, 'lane_3')).toEqual({});
    expect(readAiBases(paths)).toEqual({ lane_1: { 'knowledge/a.md': checksum('A\n') }, lane_2: { 'knowledge/b.md': checksum('B\n') } });
    writeAiBase(paths, 'lane_1', null);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 2, lanes: { lane_2: { 'knowledge/b.md': checksum('B\n') } } });
    writeFileSync(file, JSON.stringify({ version: 1, base: { 'knowledge/a.md': checksum('A\n') } }));
    expect(readAiBase(paths, 'lane_2')).toEqual({});
    writeFileSync(file, JSON.stringify({ version: 2, lanes: { lane_1: { x: 42 } } }));
    expect(() => readAiBase(paths, 'lane_1')).toThrow(MalformedConfigError);
    writeFileSync(file, '[]');
    expect(() => readAiBase(paths, 'lane_1')).toThrow(MalformedConfigError);
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
