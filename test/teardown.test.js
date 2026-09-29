import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCreate } from '../src/commands/create.js';
import { runKeep } from '../src/commands/lanes.js';
import { runTeardown } from '../src/commands/teardown.js';
import { loadContainer } from '../src/lib/container.js';
import { readLanes, updateLanes } from '../src/lib/lanes-store.js';
import { BlockedError, InvalidInputError } from '../src/lib/errors.js';
import { tmp, cleanupTmp, setupContainer, gitIn, runCli } from './helpers.js';

afterEach(cleanupTmp);

async function lane(opts = {}) {
  const s = await setupContainer(opts);
  const l = await runCreate({ container: s.container }, s.deps);
  return { ...s, dir: l.path };
}

const state = (s) => readLanes(loadContainer({ container: s.container }, s.deps)).lanes.lane_1;

describe('teardown without --remove-dir', () => {
  it('archives plans, deletes context, marks closed and leaves the clone', async () => {
    const s = await lane();
    writeFileSync(join(s.dir, '.ai', 'plans', 'task.md'), 'plan\n');
    writeFileSync(join(s.dir, '.ai', 'context', 'handoff.md'), 'notes\n');
    const r = await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    expect(r).toMatchObject({ dryRun: false, lane: 'lane_1', archivedTo: '.ai/archive/2026-09-29_lane_1', contextDeleted: true, removedDir: false });
    expect(readFileSync(join(s.container, '.ai', 'archive', '2026-09-29_lane_1', 'plans', 'task.md'), 'utf8')).toBe('plan\n');
    expect(existsSync(join(s.dir, '.ai', 'context', 'handoff.md'))).toBe(false);
    expect(existsSync(s.dir)).toBe(true);
    expect(state(s)).toMatchObject({ state: 'closed', status: 'closed', closed: '2026-09-29T12:00:00.000Z' });
    expect(readFileSync(join(s.container, '.ai', 'context', 'LANES_BOARD.md'), 'utf8')).toContain('1 closed lane');
    await expect(runTeardown({ lane: 'lane_1', container: s.container }, s.deps)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('tears down a lane left in "spinning up" by an interrupted create, without --remove-dir', async () => {
    const s = await lane();
    const ctx = loadContainer({ container: s.container }, s.deps);
    await updateLanes(ctx, s.deps, (st) => {
      st.lanes.lane_1.status = 'spinning up';
      return { state: st, result: null, activity: [] };
    });
    expect(state(s).status).toBe('spinning up');
    const r = await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    expect(r).toMatchObject({ removedDir: false });
    expect(state(s)).toMatchObject({ state: 'closed', status: 'closed' });
    expect(existsSync(s.dir)).toBe(true);
  });

  it('never archives or deletes files the repository tracks', async () => {
    const s = await lane({ files: { 'README.md': 'x\n', '.ai/plans/README.md': 'project plans\n', '.ai/context/README.md': 'project context\n' } });
    writeFileSync(join(s.dir, '.ai', 'plans', 'mine.md'), 'm\n');
    await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    expect(readFileSync(join(s.dir, '.ai', 'plans', 'README.md'), 'utf8')).toBe('project plans\n');
    expect(readFileSync(join(s.dir, '.ai', 'context', 'README.md'), 'utf8')).toBe('project context\n');
    expect(existsSync(join(s.dir, '.ai', 'plans', 'mine.md'))).toBe(false);
    expect(gitIn(s.dir, 'status', '--porcelain')).toBe('');
  });
});

describe('teardown --remove-dir safety', () => {
  it('removes a clean lane', async () => {
    const s = await lane();
    const r = await runTeardown({ lane: 'lane_1', removeDir: true, container: s.container }, s.deps);
    expect(r.removedDir).toBe(true);
    expect(existsSync(s.dir)).toBe(false);
  });

  const unsafe = {
    'uncommitted changes': (dir) => writeFileSync(join(dir, 'new.txt'), 'x\n'),
    'a stash entry': (dir) => {
      writeFileSync(join(dir, 'README.md'), 'changed\n');
      gitIn(dir, 'stash', '-q');
    },
    'an unpushed branch with no upstream': (dir) => {
      gitIn(dir, 'checkout', '-q', '-b', 'local-only');
      gitIn(dir, 'commit', '-q', '--allow-empty', '-m', 'local');
    },
    'a commit only in refs/backup': (dir) => {
      gitIn(dir, 'checkout', '-q', '-b', 'tmp');
      gitIn(dir, 'commit', '-q', '--allow-empty', '-m', 'backup');
      gitIn(dir, 'update-ref', 'refs/backup/pre-rebase', 'HEAD');
      gitIn(dir, 'checkout', '-q', 'main');
      gitIn(dir, 'branch', '-q', '-D', 'tmp');
    },
    'a local tag on an unpushed commit': (dir) => {
      gitIn(dir, 'checkout', '-q', '--detach');
      gitIn(dir, 'commit', '-q', '--allow-empty', '-m', 'tagged');
      gitIn(dir, 'tag', 'v-local');
      gitIn(dir, 'checkout', '-q', 'main');
    },
  };

  for (const [what, make] of Object.entries(unsafe)) {
    it(`refuses a lane holding ${what}, touching nothing`, async () => {
      const s = await lane();
      make(s.dir);
      writeFileSync(join(s.dir, '.ai', 'plans', 'task.md'), 'plan\n');
      const err = await runTeardown({ lane: 'lane_1', removeDir: true, container: s.container }, s.deps).catch((e) => e);
      expect(err).toBeInstanceOf(BlockedError);
      expect(err.exitCode).toBe(3);
      expect(err.message).toContain('Nothing has been archived or deleted');
      expect(existsSync(join(s.dir, '.ai', 'plans', 'task.md'))).toBe(true);
      expect(state(s).state).toBe('active');
    });
  }

  it('names a detached HEAD that holds unpushed commits', async () => {
    const s = await lane();
    gitIn(s.dir, 'checkout', '-q', '--detach');
    gitIn(s.dir, 'commit', '-q', '--allow-empty', '-m', 'detached');
    const err = await runTeardown({ lane: 'lane_1', removeDir: true, container: s.container }, s.deps).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedError);
    expect(err.message).toContain('HEAD (1)');
  });

  it('refuses a directory that is not a git repository unless forced', async () => {
    const s = await lane();
    rmSync(join(s.dir, '.git'), { recursive: true, force: true });
    const err = await runTeardown({ lane: 'lane_1', removeDir: true, container: s.container }, s.deps).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedError);
    expect(err.exitCode).toBe(3);
    expect(err.message).toContain('not a git repository');
    expect(existsSync(s.dir)).toBe(true);
    const r = await runTeardown({ lane: 'lane_1', removeDir: true, force: true, container: s.container }, s.deps);
    expect(r).toMatchObject({ removedDir: true, forced: true });
    expect(existsSync(s.dir)).toBe(false);
  });

  it('re-checks keep under the lock: a keep landing during the checks wins', async () => {
    const s = await lane();
    writeFileSync(join(s.dir, '.ai', 'plans', 'task.md'), 'plan\n');
    const ctx = loadContainer({ container: s.container }, s.deps);
    const git = (args, o) => {
      if (args[0] === 'stash') {
        const st = readLanes(ctx);
        st.lanes.lane_1.kept = { reason: 'late keep', since: '2026-09-29T12:00:00.000Z' };
        writeFileSync(ctx.paths.lanes, JSON.stringify(st));
      }
      return s.deps.git(args, o);
    };
    const err = await runTeardown({ lane: 'lane_1', removeDir: true, container: s.container }, { ...s.deps, git }).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedError);
    expect(err.message).toContain('kept');
    expect(existsSync(s.dir)).toBe(true);
    expect(existsSync(join(s.dir, '.ai', 'plans', 'task.md'))).toBe(true);
    expect(state(s).state).toBe('active');
  });

  it('names the refs that hold unpushed commits', async () => {
    const s = await lane();
    unsafe['a commit only in refs/backup'](s.dir);
    const err = await runTeardown({ lane: 'lane_1', removeDir: true, container: s.container }, s.deps).catch((e) => e);
    expect(err.message).toContain('refs/backup/pre-rebase');
  });

  it('--force overrides unpushed work, but never a kept lane', async () => {
    const s = await lane();
    unsafe['uncommitted changes'](s.dir);
    const r = await runTeardown({ lane: 'lane_1', removeDir: true, force: true, container: s.container }, s.deps);
    expect(r).toMatchObject({ removedDir: true, forced: true });
    const k = await lane();
    await runKeep({ lane: 'lane_1', reason: 'stack base', container: k.container }, k.deps);
    await expect(runTeardown({ lane: 'lane_1', removeDir: true, force: true, container: k.container }, k.deps)).rejects.toThrow(/kept/);
    expect(existsSync(k.dir)).toBe(true);
  });

  it('dry run reports what would happen and changes nothing', async () => {
    const s = await lane();
    unsafe['uncommitted changes'](s.dir);
    const r = await runTeardown({ lane: 'lane_1', removeDir: true, dryRun: true, container: s.container }, s.deps);
    expect(r).toMatchObject({ dryRun: true, blocked: true });
    expect(r.checks.problems[0]).toContain('uncommitted');
    expect(existsSync(s.dir)).toBe(true);
    expect(state(s).state).toBe('active');
  });

  it('refuses when the lane directory has been replaced by a symlink out of the container', async () => {
    const s = await lane();
    const outside = tmp();
    writeFileSync(join(outside, 'precious.txt'), 'x\n');
    renameSync(s.dir, join(s.root, 'moved'));
    symlinkSync(outside, s.dir);
    await expect(runTeardown({ lane: 'lane_1', removeDir: true, force: true, container: s.container }, s.deps)).rejects.toBeInstanceOf(BlockedError);
    expect(existsSync(join(outside, 'precious.txt'))).toBe(true);
  });

  it('requires an explicit lane name and wires into the CLI', async () => {
    const s = await lane();
    await expect(runTeardown({ container: s.container }, { ...s.deps, cwd: () => s.dir })).rejects.toBeInstanceOf(InvalidInputError);
    const r = await runCli(['teardown', 'lane_1', '--remove-dir', '--container', s.container, '--format', 'table'], s.deps);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('lane_1 torn down');
  });
});
