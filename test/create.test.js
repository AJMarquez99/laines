import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCreate } from '../src/commands/create.js';
import { loadContainer } from '../src/lib/container.js';
import { readLanes } from '../src/lib/lanes-store.js';
import { BlockedError, GitError, HookError, InvalidInputError, MalformedConfigError } from '../src/lib/errors.js';
import { cleanupTmp, setupContainer, gitIn, runCli, writeHook, setConfig } from './helpers.js';

afterEach(cleanupTmp);

describe('create', () => {
  it('clones an isolated lane, writes its files and registers it on the board', async () => {
    const { deps, container } = await setupContainer();
    const r = await runCreate({ container }, deps);
    const laneDir = join(container, 'lane_1');
    expect(r).toMatchObject({ dryRun: false, lane: 'lane_1', id: 'my-app/lane_1', number: 1, path: laneDir, branch: 'main', ports: [20000, 20009], warnings: [] });
    expect(gitIn(laneDir, 'branch', '--show-current').trim()).toBe('main');
    expect(gitIn(laneDir, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(laneDir, '.laines.env'), 'utf8')).toContain('LANE_SUFFIX="_my_app_l1"');
    const ctx = loadContainer({ container }, deps);
    expect(readLanes(ctx).lanes.lane_1).toMatchObject({ state: 'active', status: 'idle', ports: [20000, 20009] });
    expect(readFileSync(ctx.paths.board, 'utf8')).toContain('<!-- lane:lane_1:start -->');
    expect(readFileSync(ctx.paths.audit, 'utf8')).toContain('"action":"create"');
    expect(r.brief.text).toContain('# Lane brief: lane_1');
    expect(r.next[0]).toBe(`cd '${laneDir}' && claude`);
  });

  it('gives each lane its own number and ports, tracks remote branches, and creates new ones', async () => {
    const { deps, container } = await setupContainer({ branches: ['feature'] });
    await runCreate({ container }, deps);
    const two = await runCreate({ container, branch: 'feature' }, deps);
    expect(two).toMatchObject({ lane: 'lane_2', ports: [20010, 20019] });
    expect(gitIn(two.path, 'rev-parse', '--abbrev-ref', '@{u}').trim()).toBe('origin/feature');
    const named = await runCreate({ container, name: 'spike', branch: 'try/new' }, deps);
    expect(named).toMatchObject({ lane: 'spike', number: 3, ports: [20020, 20029] });
    expect(gitIn(named.path, 'branch', '--show-current').trim()).toBe('try/new');
  });

  it('dry run plans without cloning or reserving', async () => {
    const { deps, container } = await setupContainer();
    const r = await runCreate({ container, dryRun: true }, deps);
    expect(r).toMatchObject({ dryRun: true, lane: 'lane_1', ports: [20000, 20009] });
    expect(existsSync(join(container, 'lane_1'))).toBe(false);
    expect(readLanes(loadContainer({ container }, deps)).lanes).toEqual({});
  });

  it('refuses bad names and branches before touching anything', async () => {
    const { deps, container } = await setupContainer();
    mkdirSync(join(container, 'taken'));
    for (const opts of [{ name: 'Bad Name' }, { name: '.ai' }, { branch: '-x' }, { branch: 'bad..ref' }, { name: 'taken' }]) {
      await expect(runCreate({ container, ...opts }, deps), JSON.stringify(opts)).rejects.toBeInstanceOf(InvalidInputError);
    }
    expect(readLanes(loadContainer({ container }, deps)).lanes).toEqual({});
  });

  it('rolls back when ports are busy or the clone fails', async () => {
    const s = await setupContainer();
    const busy = { ...s.deps, busyPorts: async ([a]) => [a] };
    await expect(runCreate({ container: s.container }, busy)).rejects.toThrow(/Ports already in use: 20000/);
    const failingGit = { ...s.deps, gitAsync: async (args, o) => (args[0] === 'clone' ? { status: 128, stdout: '', stderr: 'fatal: repository not found' } : s.deps.gitAsync(args, o)) };
    await expect(runCreate({ container: s.container }, failingGit)).rejects.toBeInstanceOf(GitError);
    const ctx = loadContainer({ container: s.container }, s.deps);
    expect(readLanes(ctx).lanes).toEqual({});
    expect(existsSync(join(s.container, 'lane_1'))).toBe(false);
    expect(readFileSync(ctx.paths.board, 'utf8')).toContain('lane creation failed');
  });

  it('rolls back a real clone when a later git step fails', async () => {
    const s = await setupContainer();
    const git = (args, o) => (args[0] === 'checkout' ? { status: 1, stdout: '', stderr: 'fatal: checkout broke' } : s.deps.git(args, o));
    await expect(runCreate({ container: s.container, branch: 'brand-new' }, { ...s.deps, git })).rejects.toBeInstanceOf(GitError);
    const ctx = loadContainer({ container: s.container }, s.deps);
    expect(existsSync(join(s.container, 'lane_1'))).toBe(false);
    expect(readLanes(ctx).lanes).toEqual({});
    expect(readFileSync(ctx.paths.board, 'utf8')).toContain('lane creation failed');
  });

  it('rethrows the original error when cleanup itself fails, and says how to finish it', async () => {
    const s = await setupContainer();
    let cloned = false;
    const warnings = [];
    const deps = {
      ...s.deps,
      gitAsync: async (args, o) => {
        if (args[0] !== 'clone') return s.deps.gitAsync(args, o);
        cloned = true;
        return { status: 128, stdout: '', stderr: 'fatal: repository not found' };
      },
      now: () => {
        if (cloned) throw new Error('clock broke');
        return s.deps.now();
      },
      warn: (m) => warnings.push(m),
    };
    await expect(runCreate({ container: s.container }, deps)).rejects.toBeInstanceOf(GitError);
    expect(warnings.join('\n')).toContain('lane_1');
    expect(warnings.join('\n')).toContain('laines teardown lane_1 --remove-dir --force');
  });

  it('names the clone remote origin even when git is configured otherwise', async () => {
    const s = await setupContainer({ branches: ['feature'] });
    const saved = { ...process.env };
    Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'clone.defaultRemoteName', GIT_CONFIG_VALUE_0: 'upstream' });
    try {
      const r = await runCreate({ container: s.container, branch: 'feature' }, s.deps);
      expect(gitIn(r.path, 'rev-parse', '--abbrev-ref', '@{u}').trim()).toBe('origin/feature');
    } finally {
      for (const k of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it('uses the number in an explicit prefixed name', async () => {
    const { deps, container } = await setupContainer();
    const three = await runCreate({ container, name: 'lane_3' }, deps);
    expect(three).toMatchObject({ lane: 'lane_3', number: 3, ports: [20020, 20029] });
    const next = await runCreate({ container }, deps);
    expect(next).toMatchObject({ lane: 'lane_1', number: 1 });
    await expect(runCreate({ container, name: 'lane_1', dryRun: true }, deps)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(runCreate({ container, name: 'lane_21', dryRun: true }, deps)).rejects.toBeInstanceOf(InvalidInputError);
    expect(await runCreate({ container, name: 'lane_0', dryRun: true }, deps)).toMatchObject({ lane: 'lane_0', number: 2 });
  });

  it('stops at maxLanes and reuses the number of a closed lane', async () => {
    const { deps, container } = await setupContainer();
    const cfgFile = join(container, '.laines', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
    writeFileSync(cfgFile, JSON.stringify({ ...cfg, maxLanes: 1 }));
    await runCreate({ container }, deps);
    await expect(runCreate({ container }, deps)).rejects.toBeInstanceOf(BlockedError);
    const lanesFile = join(container, '.laines', 'lanes.json');
    const state = JSON.parse(readFileSync(lanesFile, 'utf8'));
    state.lanes.lane_1.state = 'closed';
    writeFileSync(lanesFile, JSON.stringify(state));
    await expect(runCreate({ container }, deps)).rejects.toThrow(/already exists/);
    const r = await runCreate({ container, name: 'fresh' }, deps);
    expect(r).toMatchObject({ lane: 'fresh', number: 1, ports: [20000, 20009] });
  });

  it('works in a container whose path has spaces, and two creates at once get different lanes', async () => {
    const { deps, container } = await setupContainer({ dir: 'my lanes' });
    const [a, b] = await Promise.all([runCreate({ container }, deps), runCreate({ container }, deps)]);
    expect(new Set([a.lane, b.lane])).toEqual(new Set(['lane_1', 'lane_2']));
    expect(gitIn(a.path, 'status', '--porcelain')).toBe('');
    expect(a.next[0]).toBe(`cd '${a.path}' && claude`);
    expect(a.next[0]).toContain('my lanes');
  });

  it('prints a table with the brief', async () => {
    const { deps, container } = await setupContainer();
    const r = await runCli(['create', '--container', container, '--format', 'table'], deps);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('lane lane_1 created');
    expect(r.stdout).toContain('# Lane brief: lane_1');
  });

  it('clones asynchronously, so a long-lived server keeps answering', async () => {
    const { deps, container } = await setupContainer();
    const sync = { ...deps, git: (args, o) => (args[0] === 'clone' ? { status: 1, stdout: '', stderr: 'sync clone used' } : deps.git(args, o)) };
    expect(await runCreate({ container }, sync)).toMatchObject({ lane: 'lane_1' });
  });
});

describe('create with hooks', () => {
  const lanes = (container, deps) => readLanes(loadContainer({ container }, deps));
  const board = (container) => readFileSync(join(container, '.ai', 'context', 'LANES_BOARD.md'), 'utf8');

  it('runs post-create in the lane after .laines.env is written, and records the hook set', async () => {
    const { deps, container } = await setupContainer();
    writeHook(container, 'post-create', 'grep -q LANE_SUFFIX "$LANE_ENV_FILE" && echo "DATABASE_URL=postgres://localhost/app$LANE_SUFFIX" >> "$LANE_ENV_FILE"');
    const r = await runCreate({ container }, deps);
    expect(r.hooks).toMatchObject({ event: 'post-create', outcome: 'ok' });
    expect(readFileSync(join(r.path, '.laines.env'), 'utf8')).toContain('DATABASE_URL=postgres://localhost/app_my_app_l1');
    expect(gitIn(r.path, 'status', '--porcelain')).toBe('');
    const st = lanes(container, deps);
    expect(st.lanes.lane_1).toMatchObject({ state: 'active', status: 'idle' });
    expect(st.hookHistory).toHaveLength(1);
    expect(Object.keys(st.hookHistory[0].checksums)).toEqual(['post-create']);
    expect(r.warnings).toEqual([expect.stringMatching(/hook post-create is new and ran unapproved \(policy notify\)/)]);
    expect(board(container)).toMatch(/unapproved hook\(s\) ran under policy notify: post-create \(new, sha256:/);
  });

  it('keeps a lane whose post-create fails, marks it setup-failed and asks for a refresh', async () => {
    const { deps, container } = await setupContainer();
    writeHook(container, 'post-create', 'echo "db down" >&2; exit 1');
    const err = await runCreate({ container }, deps).catch((e) => e);
    expect(err).toBeInstanceOf(HookError);
    expect(err.exitCode).toBe(1);
    expect(err.message).toContain('db down');
    expect(err.message).toContain('untrusted');
    expect(err.message).toContain('laines refresh lane_1');
    expect(existsSync(join(container, 'lane_1', '.laines.env'))).toBe(true);
    const st = lanes(container, deps);
    expect(st.lanes.lane_1).toMatchObject({ state: 'setup-failed', status: 'setup-failed' });
    expect(st.requests.find((q) => q.id === 'setup-failed:lane_1')).toMatchObject({ command: 'laines refresh lane_1' });
    expect(st.hookHistory).toEqual([]);
    expect(board(container)).toContain('⚠️ setup-failed');
  });

  it('exits 3 when post-create exits 3', async () => {
    const { deps, container } = await setupContainer();
    writeHook(container, 'post-create', 'echo "start Postgres, then refresh"; exit 3');
    const err = await runCreate({ container }, deps).catch((e) => e);
    expect(err.exitCode).toBe(3);
    expect(lanes(container, deps).lanes.lane_1.state).toBe('setup-failed');
  });

  it('under policy approve, refuses an unapproved hook without running it', async () => {
    const { deps, container } = await setupContainer();
    setConfig(container, (c) => { c.hooks.policy = 'approve'; });
    writeHook(container, 'post-create', 'touch "$LANE_DIR/ran"');
    const err = await runCreate({ container }, deps).catch((e) => e);
    expect(err).toBeInstanceOf(HookError);
    expect(err.exitCode).toBe(3);
    expect(err.message).toContain('+touch "$LANE_DIR/ran"');
    expect(existsSync(join(container, 'lane_1', 'ran'))).toBe(false);
    const st = lanes(container, deps);
    expect(st.requests.map((q) => q.id).sort()).toEqual(['hooks-changed:*', 'setup-failed:lane_1']);
    expect(st.requests.find((q) => q.kind === 'setup-failed').command).toBe('laines hooks approve && laines refresh lane_1');
  });

  it('suggests locking once the hook set is unchanged across stableAfter creates', async () => {
    const { deps, container } = await setupContainer();
    setConfig(container, (c) => { c.hooks.stableAfter = 2; });
    writeHook(container, 'post-create', 'true');
    const a = await runCreate({ container }, deps);
    expect(a.next.join('\n')).not.toContain('--lock');
    const b = await runCreate({ container }, deps);
    expect(b.next.at(-1)).toContain('laines hooks approve --lock');
    expect(lanes(container, deps).requests.map((q) => q.id)).toContain('hooks-lock:*');
    expect(board(container)).toContain('`laines hooks approve --lock`');
    writeHook(container, 'post-create', 'true # changed');
    const c = await runCreate({ container }, deps);
    expect(c.next.join('\n')).not.toContain('--lock');
    expect(lanes(container, deps).requests.map((q) => q.id)).not.toContain('hooks-lock:*');
  });

  it('dry run lists the hooks that would run and runs none', async () => {
    const { deps, container } = await setupContainer();
    writeHook(container, 'post-create', 'touch "$CONTAINER_DIR/ran"');
    const r = await runCreate({ container, dryRun: true }, deps);
    expect(r.hooks).toMatchObject({ event: 'post-create', wouldRun: true, hooks: [{ hook: 'post-create', state: 'new' }] });
    expect(existsSync(join(container, 'ran'))).toBe(false);
  });

  it('fails before cloning when hooks.lock.json is malformed', async () => {
    const { deps, container } = await setupContainer();
    writeFileSync(join(container, '.laines', 'hooks.lock.json'), '{');
    await expect(runCreate({ container }, deps)).rejects.toBeInstanceOf(MalformedConfigError);
    expect(existsSync(join(container, 'lane_1'))).toBe(false);
    expect(lanes(container, deps).lanes).toEqual({});
  });

  it('treats lane_003 as a custom name, not lane number 3', async () => {
    const { deps, container } = await setupContainer();
    expect(await runCreate({ container, name: 'lane_003' }, deps)).toMatchObject({ lane: 'lane_003', number: 1 });
  });

  it('uses the container copy of lane-local-instructions.md when a team customises it', async () => {
    const { deps, container } = await setupContainer();
    const own = join(container, '.ai', 'templates', 'lane-local-instructions.md');
    expect(existsSync(own)).toBe(true);
    writeFileSync(own, 'Custom rules for {{lane}}\n');
    const r = await runCreate({ container }, deps);
    expect(readFileSync(join(r.path, 'CLAUDE.local.md'), 'utf8')).toBe('Custom rules for lane_1\n');
  });
});
