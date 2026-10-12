import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCreate } from '../src/commands/create.js';
import { runKeep } from '../src/commands/lanes.js';
import { runTeardown } from '../src/commands/teardown.js';
import { loadContainer } from '../src/lib/container.js';
import { readLanes, updateLanes } from '../src/lib/lanes-store.js';
import { BlockedError, HookError, InvalidInputError, MalformedConfigError } from '../src/lib/errors.js';
import { tmp, cleanupTmp, setupContainer, gitIn, runCli, writeHook, setConfig } from './helpers.js';

afterEach(cleanupTmp);

async function lane(opts = {}) {
  const s = await setupContainer(opts);
  const l = await runCreate({ container: s.container }, s.deps);
  return { ...s, dir: l.path };
}

const state = (s) => readLanes(loadContainer({ container: s.container }, s.deps)).lanes.lane_1;

describe('teardown with --keep-dir', () => {
  it('archives plans, deletes context, marks closed and leaves the clone', async () => {
    const s = await lane();
    writeFileSync(join(s.dir, '.ai', 'plans', 'task.md'), 'plan\n');
    writeFileSync(join(s.dir, '.ai', 'context', 'handoff.md'), 'notes\n');
    const r = await runTeardown({ lane: 'lane_1', keepDir: true, container: s.container }, s.deps);
    expect(r).toMatchObject({ dryRun: false, lane: 'lane_1', archivedTo: '.ai/archive/2026-09-29_lane_1', contextDeleted: true, removedDir: false });
    expect(readFileSync(join(s.container, '.ai', 'archive', '2026-09-29_lane_1', 'plans', 'task.md'), 'utf8')).toBe('plan\n');
    expect(existsSync(join(s.dir, '.ai', 'context', 'handoff.md'))).toBe(false);
    expect(existsSync(s.dir)).toBe(true);
    expect(state(s)).toMatchObject({ state: 'closed', status: 'closed', closed: '2026-09-29T12:00:00.000Z' });
    expect(readFileSync(join(s.container, '.ai', 'context', 'LANES_BOARD.md'), 'utf8')).toContain('1 closed lane');
    await expect(runTeardown({ lane: 'lane_1', keepDir: true, container: s.container }, s.deps)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('tears down a lane left in "spinning up" by an interrupted create, with --keep-dir', async () => {
    const s = await lane();
    const ctx = loadContainer({ container: s.container }, s.deps);
    await updateLanes(ctx, s.deps, (st) => {
      st.lanes.lane_1.status = 'spinning up';
      return { state: st, result: null, activity: [] };
    });
    expect(state(s).status).toBe('spinning up');
    const r = await runTeardown({ lane: 'lane_1', keepDir: true, container: s.container }, s.deps);
    expect(r).toMatchObject({ removedDir: false });
    expect(state(s)).toMatchObject({ state: 'closed', status: 'closed' });
    expect(existsSync(s.dir)).toBe(true);
  });

  it('never archives or deletes files the repository tracks', async () => {
    const s = await lane({ files: { 'README.md': 'x\n', '.ai/plans/README.md': 'project plans\n', '.ai/context/README.md': 'project context\n' } });
    writeFileSync(join(s.dir, '.ai', 'plans', 'mine.md'), 'm\n');
    await runTeardown({ lane: 'lane_1', keepDir: true, container: s.container }, s.deps);
    expect(readFileSync(join(s.dir, '.ai', 'plans', 'README.md'), 'utf8')).toBe('project plans\n');
    expect(readFileSync(join(s.dir, '.ai', 'context', 'README.md'), 'utf8')).toBe('project context\n');
    expect(existsSync(join(s.dir, '.ai', 'plans', 'mine.md'))).toBe(false);
    expect(gitIn(s.dir, 'status', '--porcelain')).toBe('');
  });
});

describe('teardown clone-removal safety (the default)', () => {
  it('removes a clean lane', async () => {
    const s = await lane();
    const r = await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
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
      const err = await runTeardown({ lane: 'lane_1', container: s.container }, s.deps).catch((e) => e);
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
    const err = await runTeardown({ lane: 'lane_1', container: s.container }, s.deps).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedError);
    expect(err.message).toContain('HEAD (1)');
  });

  it('refuses a directory that is not a git repository unless forced', async () => {
    const s = await lane();
    rmSync(join(s.dir, '.git'), { recursive: true, force: true });
    const err = await runTeardown({ lane: 'lane_1', container: s.container }, s.deps).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedError);
    expect(err.exitCode).toBe(3);
    expect(err.message).toContain('not a git repository');
    expect(err.message).toContain(`Copy anything you need out of ${s.dir} first.`);
    expect(err.message).not.toContain('bundle');
    expect(existsSync(s.dir)).toBe(true);
    const r = await runTeardown({ lane: 'lane_1', force: true, container: s.container }, s.deps);
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
    const err = await runTeardown({ lane: 'lane_1', container: s.container }, { ...s.deps, git }).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedError);
    expect(err.message).toContain('kept');
    expect(existsSync(s.dir)).toBe(true);
    expect(existsSync(join(s.dir, '.ai', 'plans', 'task.md'))).toBe(true);
    expect(state(s).state).toBe('active');
  });

  it('names the refs that hold unpushed commits', async () => {
    const s = await lane();
    unsafe['a commit only in refs/backup'](s.dir);
    const err = await runTeardown({ lane: 'lane_1', container: s.container }, s.deps).catch((e) => e);
    expect(err.message).toContain('refs/backup/pre-rebase');
  });

  it('--force overrides unpushed work, but never a kept lane', async () => {
    const s = await lane();
    unsafe['uncommitted changes'](s.dir);
    const r = await runTeardown({ lane: 'lane_1', force: true, container: s.container }, s.deps);
    expect(r).toMatchObject({ removedDir: true, forced: true });
    const k = await lane();
    await runKeep({ lane: 'lane_1', reason: 'stack base', container: k.container }, k.deps);
    await expect(runTeardown({ lane: 'lane_1', force: true, container: k.container }, k.deps)).rejects.toThrow(/kept/);
    expect(existsSync(k.dir)).toBe(true);
  });

  it('dry run reports what would happen and changes nothing', async () => {
    const s = await lane();
    unsafe['uncommitted changes'](s.dir);
    const r = await runTeardown({ lane: 'lane_1', dryRun: true, container: s.container }, s.deps);
    expect(r).toMatchObject({ dryRun: true, blocked: true, removedDir: true });
    expect(r).not.toHaveProperty('removeDir');
    expect(r.checks.problems[0]).toContain('uncommitted');
    expect(existsSync(s.dir)).toBe(true);
    expect(state(s).state).toBe('active');
  });

  it('archives plans written after a lane was closed before removing its clone', async () => {
    const s = await lane();
    await runTeardown({ lane: 'lane_1', keepDir: true, container: s.container }, s.deps);
    writeFileSync(join(s.dir, '.ai', 'plans', 'late.md'), 'late\n');
    writeFileSync(join(s.dir, '.ai', 'context', 'late.md'), 'ctx\n');
    const r = await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    expect(r).toMatchObject({ removedDir: true, archivedTo: '.ai/archive/2026-09-29_lane_1-2', contextDeleted: true });
    expect(readFileSync(join(s.container, '.ai', 'archive', '2026-09-29_lane_1-2', 'plans', 'late.md'), 'utf8')).toBe('late\n');
    expect(existsSync(s.dir)).toBe(false);
  });

  it('refuses when the lane directory has been replaced by a symlink out of the container', async () => {
    const s = await lane();
    const outside = tmp();
    writeFileSync(join(outside, 'precious.txt'), 'x\n');
    renameSync(s.dir, join(s.root, 'moved'));
    symlinkSync(outside, s.dir);
    await expect(runTeardown({ lane: 'lane_1', force: true, container: s.container }, s.deps)).rejects.toBeInstanceOf(BlockedError);
    expect(existsSync(join(outside, 'precious.txt'))).toBe(true);
  });

  it('requires an explicit lane name and wires into the CLI', async () => {
    const s = await lane();
    await expect(runTeardown({ container: s.container }, { ...s.deps, cwd: () => s.dir })).rejects.toBeInstanceOf(InvalidInputError);
    const r = await runCli(['teardown', 'lane_1', '--container', s.container, '--format', 'table'], s.deps);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('lane_1 torn down');
  });
});

describe('teardown deletes the clone by default (0.4.9 Task 7)', () => {
  it('default deletes a clean lane\'s clone', async () => {
    const s = await lane();
    const r = await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    expect(r.removedDir).toBe(true);
    expect(existsSync(s.dir)).toBe(false);
    expect(state(s).state).toBe('closed');
  });

  it('default refuses unpushed work over the CLI (exit 3, naming --force), touching nothing', async () => {
    const s = await lane();
    writeFileSync(join(s.dir, 'new.txt'), 'x\n');
    const r = await runCli(['teardown', 'lane_1', '--container', s.container], s.deps);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('--force');
    expect(existsSync(s.dir)).toBe(true);
    expect(state(s).state).toBe('active');
  });

  it('--keep-dir keeps the clone and skips the unpushed-work checks', async () => {
    const s = await lane();
    writeFileSync(join(s.dir, 'new.txt'), 'x\n');
    const r = await runCli(['teardown', 'lane_1', '--keep-dir', '--container', s.container, '--format', 'json'], s.deps);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ removedDir: false });
    expect(existsSync(join(s.dir, 'new.txt'))).toBe(true);
    expect(state(s).state).toBe('closed');
  });

  it('--keep-dir together with --remove-dir is an input error (exit 2)', async () => {
    const s = await lane();
    const r = await runCli(['teardown', 'lane_1', '--keep-dir', '--remove-dir', '--container', s.container], s.deps);
    expect(r.code).toBe(2);
    expect(state(s).state).toBe('active');
    await expect(runTeardown({ lane: 'lane_1', keepDir: true, removeDir: true, container: s.container }, s.deps)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('--remove-dir is still accepted as a no-op alias, and its help text says deprecated', async () => {
    const s = await lane();
    const r = await runCli(['teardown', 'lane_1', '--remove-dir', '--container', s.container, '--format', 'json'], s.deps);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ removedDir: true });
    const help = await runCli(['teardown', '--help'], s.deps);
    expect(help.stdout).toMatch(/--keep-dir/);
    expect(help.stdout).toMatch(/deprecated/i);
  });

  it('re-tearing a closed lane that kept its clone deletes it; --keep-dir on a closed lane is the input error', async () => {
    const s = await lane();
    await runTeardown({ lane: 'lane_1', keepDir: true, container: s.container }, s.deps);
    expect(existsSync(s.dir)).toBe(true);
    await expect(runTeardown({ lane: 'lane_1', keepDir: true, container: s.container }, s.deps)).rejects.toBeInstanceOf(InvalidInputError);
    const r = await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    expect(r.removedDir).toBe(true);
    expect(existsSync(s.dir)).toBe(false);
  });

  it('dry run shows the clone will be deleted by default, and kept with keepDir', async () => {
    const s = await lane();
    expect(await runTeardown({ lane: 'lane_1', dryRun: true, container: s.container }, s.deps)).toMatchObject({ dryRun: true, removedDir: true });
    expect(await runTeardown({ lane: 'lane_1', dryRun: true, keepDir: true, container: s.container }, s.deps)).toMatchObject({ removedDir: false });
    expect(existsSync(s.dir)).toBe(true);
  });
});

describe('teardown --keep-dir retry hint', () => {
  it('the printed post-teardown retry keeps the clone', async () => {
    const s = await lane();
    writeHook(s.container, 'post-teardown', 'exit 1');
    const r = await runTeardown({ lane: 'lane_1', keepDir: true, container: s.container }, s.deps);
    expect(r.warnings.join('\n')).toContain('laines teardown lane_1 --keep-dir');
    const q = readLanes(loadContainer({ container: s.container }, s.deps)).requests.find((x) => x.id === 'cleanup-incomplete:lane_1');
    expect(q.command).toBe('laines teardown lane_1 --keep-dir');
    writeHook(s.container, 'post-teardown', 'true');
    const out = await runCli([...q.command.split(' ').slice(1), '--container', s.container], s.deps);
    expect(out.code).toBe(0);
    expect(existsSync(s.dir)).toBe(true);
  });
});

describe('teardown hooks', () => {
  const requests = (s) => readLanes(loadContainer({ container: s.container }, s.deps)).requests;
  const board = (s) => readFileSync(join(s.container, '.ai', 'context', 'LANES_BOARD.md'), 'utf8');

  it('runs pre-teardown in the lane before anything is archived, and post-teardown in the container after', async () => {
    const s = await lane();
    writeFileSync(join(s.dir, '.ai', 'plans', 'task.md'), 'plan\n');
    writeHook(s.container, 'pre-teardown', 'test -f .ai/plans/task.md && echo "pre $LANE_NAME" >> "$CONTAINER_DIR/hooks.log"');
    writeHook(s.container, 'post-teardown', 'test ! -d "$LANE_DIR" && echo "post $(pwd -P)" >> "$CONTAINER_DIR/hooks.log"');
    const r = await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    expect(readFileSync(join(s.container, 'hooks.log'), 'utf8')).toBe(`pre lane_1\npost ${s.container}\n`);
    expect(r.hooks.map((h) => [h.event, h.outcome])).toEqual([['pre-teardown', 'ok'], ['post-teardown', 'ok']]);
  });

  it('reproduces per-lane database isolation purely with hooks (spec §14, criterion 4)', async () => {
    const s = await setupContainer();
    writeHook(s.container, 'post-create', 'mkdir -p "$CONTAINER_DIR/dbs" && touch "$CONTAINER_DIR/dbs/app$LANE_SUFFIX" && echo "DATABASE=app$LANE_SUFFIX" >> "$LANE_ENV_FILE"');
    writeHook(s.container, 'post-teardown', 'rm -f "$CONTAINER_DIR/dbs/app$LANE_SUFFIX"');
    await runCreate({ container: s.container }, s.deps);
    const two = await runCreate({ container: s.container }, s.deps);
    expect(readdirSync(join(s.container, 'dbs')).sort()).toEqual(['app_my_app_l1', 'app_my_app_l2']);
    expect(readFileSync(join(two.path, '.laines.env'), 'utf8')).toContain('DATABASE=app_my_app_l2');
    await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    expect(readdirSync(join(s.container, 'dbs'))).toEqual(['app_my_app_l2']);
  });

  it('a failing pre-teardown aborts with nothing touched', async () => {
    const s = await lane();
    writeFileSync(join(s.dir, '.ai', 'plans', 'task.md'), 'plan\n');
    writeHook(s.container, 'pre-teardown', 'echo "server still running" >&2; exit 1');
    const err = await runTeardown({ lane: 'lane_1', container: s.container }, s.deps).catch((e) => e);
    expect(err).toBeInstanceOf(HookError);
    expect(err.exitCode).toBe(1);
    expect(err.message).toContain('server still running');
    expect(err.message).toContain('Teardown aborted: nothing was archived or deleted.');
    expect(state(s)).toMatchObject({ state: 'active' });
    expect(readFileSync(join(s.dir, '.ai', 'plans', 'task.md'), 'utf8')).toBe('plan\n');
    expect(board(s)).toContain('teardown aborted, nothing touched');
  });

  it('pre-teardown exit 3 asks a human and exits 3', async () => {
    const s = await lane();
    writeHook(s.container, 'pre-teardown', 'echo "stop the server first"; exit 3');
    const err = await runTeardown({ lane: 'lane_1', container: s.container }, s.deps).catch((e) => e);
    expect(err.exitCode).toBe(3);
    expect(requests(s).find((q) => q.id === 'teardown-blocked:lane_1')).toMatchObject({ command: 'laines teardown lane_1' });
    expect(state(s).state).toBe('active');
  });

  it('under policy approve an unapproved pre-teardown is refused and nothing is touched', async () => {
    const s = await lane();
    setConfig(s.container, (c) => { c.hooks.policy = 'approve'; });
    writeHook(s.container, 'pre-teardown', 'true');
    const err = await runTeardown({ lane: 'lane_1', container: s.container }, s.deps).catch((e) => e);
    expect(err.exitCode).toBe(3);
    expect(state(s).state).toBe('active');
    expect(requests(s).map((q) => q.id).sort()).toEqual(['hooks-changed:*', 'teardown-blocked:lane_1']);
    expect(requests(s).find((q) => q.id === 'teardown-blocked:lane_1').command).toBe('laines hooks approve && laines teardown lane_1');
  });

  it('a failing post-teardown closes the lane with a cleanup request, and teardown retries it', async () => {
    const s = await lane();
    writeHook(s.container, 'post-teardown', 'echo "dropdb failed" >&2; exit 1');
    const r = await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    expect(state(s).state).toBe('closed');
    expect(r.warnings.join('\n')).toMatch(/cleanup incomplete: post-teardown exited 1/);
    expect(requests(s).find((q) => q.id === 'cleanup-incomplete:lane_1')).toMatchObject({ command: 'laines teardown lane_1' });

    writeHook(s.container, 'post-teardown', 'touch "$CONTAINER_DIR/cleaned"');
    const retry = await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    expect(retry.hooks.map((h) => [h.event, h.outcome])).toEqual([['post-teardown', 'ok']]);
    expect(existsSync(join(s.container, 'cleaned'))).toBe(true);
    expect(requests(s).filter((q) => q.lane === 'lane_1')).toEqual([]);
    await expect(runTeardown({ lane: 'lane_1', container: s.container }, s.deps)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('under policy approve an unapproved post-teardown still closes the lane and asks for approval first', async () => {
    const s = await lane();
    setConfig(s.container, (c) => { c.hooks.policy = 'approve'; });
    writeHook(s.container, 'post-teardown', 'true');
    const r = await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    expect(state(s).state).toBe('closed');
    expect(requests(s).find((q) => q.id === 'cleanup-incomplete:lane_1')).toMatchObject({ command: 'laines hooks approve && laines teardown lane_1' });
    expect(r.warnings.join('\n')).toContain('`laines hooks approve && laines teardown lane_1`');
  });

  it('a pre-teardown that stops teardown is not left blocking once the lane is kept', async () => {
    const s = await lane();
    writeHook(s.container, 'pre-teardown', 'exit 3');
    await expect(runTeardown({ lane: 'lane_1', container: s.container }, s.deps)).rejects.toMatchObject({ exitCode: 3 });
    expect(requests(s).map((q) => q.id)).toContain('teardown-blocked:lane_1');
    await runKeep({ lane: 'lane_1', reason: 'still needed', container: s.container }, s.deps);
    expect(requests(s).map((q) => q.id)).not.toContain('teardown-blocked:lane_1');
  });

  it('a malformed hooks.lock.json fails before anything is touched', async () => {
    const s = await lane();
    writeFileSync(join(s.dir, '.ai', 'plans', 'task.md'), 'plan\n');
    writeFileSync(loadContainer({ container: s.container }, s.deps).paths.hooksLock, '{ not json');
    await expect(runTeardown({ lane: 'lane_1', container: s.container }, s.deps)).rejects.toBeInstanceOf(MalformedConfigError);
    expect(state(s).state).toBe('active');
    expect(readFileSync(join(s.dir, '.ai', 'plans', 'task.md'), 'utf8')).toBe('plan\n');
  });

  it('skips pre-teardown when the clone is missing, and still runs post-teardown', async () => {
    const s = await lane();
    rmSync(s.dir, { recursive: true, force: true });
    writeHook(s.container, 'pre-teardown', 'exit 1');
    writeHook(s.container, 'post-teardown', 'touch "$CONTAINER_DIR/post-ran"');
    const r = await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    expect(r.warnings.join('\n')).toContain('pre-teardown skipped');
    expect(existsSync(join(s.container, 'post-ran'))).toBe(true);
    expect(state(s).state).toBe('closed');
  });

  it('dry run lists the hooks that would run and runs none', async () => {
    const s = await lane();
    writeHook(s.container, 'pre-teardown', 'touch "$CONTAINER_DIR/pre-ran"');
    writeHook(s.container, 'post-teardown', 'touch "$CONTAINER_DIR/post-ran"');
    const r = await runTeardown({ lane: 'lane_1', dryRun: true, container: s.container }, s.deps);
    expect(r.hooks.map((h) => [h.event, h.wouldRun])).toEqual([['pre-teardown', true], ['post-teardown', true]]);
    expect(existsSync(join(s.container, 'pre-ran'))).toBe(false);
    expect(existsSync(join(s.container, 'post-ran'))).toBe(false);
  });

  it('logs the second phase of a two-step teardown on the board', async () => {
    const s = await lane();
    await runTeardown({ lane: 'lane_1', keepDir: true, container: s.container }, s.deps);
    await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    expect(board(s)).toContain('clone removed');
  });
});

describe('closed lane: clone removal is recorded (0.4.9 Task 6)', () => {
  const board = (s) => readFileSync(join(s.container, '.ai', 'context', 'LANES_BOARD.md'), 'utf8');
  const closedLine = (s) => board(s).split('\n').find((l) => l.startsWith('- `lane_1` · closed'));

  it('close with --keep-dir says the clone remains; removing it later records when and on which branch', async () => {
    const s = await lane();
    await runTeardown({ lane: 'lane_1', keepDir: true, container: s.container }, s.deps);
    expect(closedLine(s)).toContain('· clone remains');
    expect(state(s).cloneRemoved).toBeUndefined();
    gitIn(s.dir, 'checkout', '-q', '-b', 'feature-x');
    const later = '2026-10-11T03:43:00.000Z';
    s.deps.now = () => later;
    await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    expect(state(s)).toMatchObject({ cloneRemoved: later, branchAtRemoval: 'feature-x', updated: later, closed: '2026-09-29T12:00:00.000Z' });
    expect(closedLine(s)).toMatch(/last branch `[^`]+` · clone removed 2026-10-11 03:43 UTC \(on `feature-x`\)/);
  });

  it('records a short sha when the clone is on a detached HEAD', async () => {
    const s = await lane();
    await runTeardown({ lane: 'lane_1', keepDir: true, container: s.container }, s.deps);
    gitIn(s.dir, 'checkout', '-q', '--detach');
    await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    expect(state(s).branchAtRemoval).toMatch(/^[0-9a-f]{7,}$/);
  });

  it('a default first teardown records cloneRemoved at the close time; keep-dir does not', async () => {
    const s = await lane();
    await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    expect(state(s)).toMatchObject({ cloneRemoved: '2026-09-29T12:00:00.000Z' });
    expect(closedLine(s)).toContain('· clone removed 2026-09-29 12:00 UTC');
  });
});

describe('closed lane: pre-teardown on clone removal (H1)', () => {
  const requests = (s) => readLanes(loadContainer({ container: s.container }, s.deps)).requests;
  const log = (s) => (existsSync(join(s.container, 'phase.log')) ? readFileSync(join(s.container, 'phase.log'), 'utf8') : '');
  const phaseHook = 'echo "$LAINES_HOOK $LAINES_TEARDOWN_PHASE" >> "$CONTAINER_DIR/phase.log"';

  it('runs with LAINES_TEARDOWN_PHASE=close on a first teardown and =remove-clone on a closed lane', async () => {
    const s = await lane();
    writeHook(s.container, 'pre-teardown', phaseHook);
    await runTeardown({ lane: 'lane_1', keepDir: true, container: s.container }, s.deps);
    expect(log(s)).toBe('pre-teardown close\n');
    const r = await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    expect(log(s)).toBe('pre-teardown close\npre-teardown remove-clone\n');
    expect(r.hooks.map((h) => h.event)).toEqual(['pre-teardown']);
    expect(existsSync(s.dir)).toBe(false);
  });

  it('does not run when the closed lane has no clone left, or only a post retry is pending', async () => {
    const s = await lane();
    writeHook(s.container, 'pre-teardown', phaseHook);
    writeHook(s.container, 'post-teardown', 'exit 1');
    await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    expect(log(s)).toBe('pre-teardown close\n');
    writeHook(s.container, 'post-teardown', 'true');
    await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    expect(log(s)).toBe('pre-teardown close\n');
  });

  it('dry run on a closed lane with a clone reports pre-teardown', async () => {
    const s = await lane();
    writeHook(s.container, 'pre-teardown', 'true');
    await runTeardown({ lane: 'lane_1', keepDir: true, container: s.container }, s.deps);
    const r = await runTeardown({ lane: 'lane_1', dryRun: true, container: s.container }, s.deps);
    expect(r.hooks.map((h) => [h.event, h.wouldRun])).toEqual([['pre-teardown', true]]);
  });

  it('a failing pre-teardown aborts with the clone intact, and a blocked one leaves a retry that keeps --force', async () => {
    const s = await lane();
    await runTeardown({ lane: 'lane_1', keepDir: true, container: s.container }, s.deps);
    writeHook(s.container, 'pre-teardown', 'exit 1');
    await expect(runTeardown({ lane: 'lane_1', container: s.container }, s.deps)).rejects.toBeInstanceOf(HookError);
    expect(existsSync(s.dir)).toBe(true);
    expect(state(s).cloneRemoved).toBeUndefined();
    writeHook(s.container, 'pre-teardown', 'exit 3');
    await expect(runTeardown({ lane: 'lane_1', container: s.container, force: true }, s.deps)).rejects.toBeInstanceOf(HookError);
    expect(existsSync(s.dir)).toBe(true);
    expect(requests(s).find((q) => q.id === 'teardown-blocked:lane_1').command).toBe('laines teardown lane_1 --force');
    writeHook(s.container, 'pre-teardown', 'true');
    await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    expect(requests(s).map((q) => q.id)).not.toContain('teardown-blocked:lane_1');
    expect(existsSync(s.dir)).toBe(false);
  });

  it('a pre-teardown that commits is refused by the expect fingerprint on the closed path', async () => {
    const s = await lane();
    await runTeardown({ lane: 'lane_1', keepDir: true, container: s.container }, s.deps);
    gitIn(s.dir, 'commit', '-q', '--allow-empty', '-m', 'work');
    const dry = await runTeardown({ lane: 'lane_1', dryRun: true, force: true, container: s.container }, s.deps);
    writeHook(s.container, 'pre-teardown', 'git commit -q --allow-empty -m "from hook"');
    await expect(runTeardown({ lane: 'lane_1', force: true, expect: dry.fingerprint, container: s.container }, s.deps)).rejects.toBeInstanceOf(BlockedError);
    expect(existsSync(s.dir)).toBe(true);
    expect(state(s).cloneRemoved).toBeUndefined();
  });

  it('audit records the pre hook outcome on a closed lane', async () => {
    const s = await lane();
    writeHook(s.container, 'pre-teardown', 'true');
    await runTeardown({ lane: 'lane_1', keepDir: true, container: s.container }, s.deps);
    await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    const entry = readFileSync(join(s.container, '.laines', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.action === 'teardown').pop();
    expect(entry.hooks.pre).toBe('ok');
  });
});
