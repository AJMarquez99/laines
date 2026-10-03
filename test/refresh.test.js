import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCreate } from '../src/commands/create.js';
import { runRefresh } from '../src/commands/refresh.js';
import { runTeardown } from '../src/commands/teardown.js';
import { loadContainer } from '../src/lib/container.js';
import { readLanes, updateLanes } from '../src/lib/lanes-store.js';
import { approveHooks } from '../src/lib/hooks.js';
import { HookError, InvalidInputError, MalformedConfigError } from '../src/lib/errors.js';
import { cleanupTmp, setupContainer, gitIn, runCli, writeHook, setConfig } from './helpers.js';

afterEach(cleanupTmp);

const ctxOf = (s) => loadContainer({ container: s.container }, s.deps);
const lane1 = (s) => readLanes(ctxOf(s)).lanes.lane_1;

describe('refresh', () => {
  it('rewrites .laines.env and re-runs post-create, so appended lines appear exactly once', async () => {
    const s = await setupContainer();
    writeHook(s.container, 'post-create', 'echo "DB=app$LANE_SUFFIX" >> "$LANE_ENV_FILE"');
    const { path } = await runCreate({ container: s.container }, s.deps);
    writeFileSync(join(path, '.laines.env'), 'HANDMADE=1\n');
    rmSync(join(path, '.ai', 'README.md'));
    await runRefresh({ lane: 'lane_1', container: s.container }, s.deps);
    const r = await runRefresh({ lane: 'lane_1', container: s.container }, s.deps);
    expect(r).toMatchObject({ dryRun: false, lane: 'lane_1', branch: 'main', hooks: { outcome: 'ok' } });
    const env = readFileSync(join(path, '.laines.env'), 'utf8');
    expect(env.match(/^DB=/gm)).toHaveLength(1);
    expect(env).toContain('LANE_NAME="lane_1"');
    expect(env).not.toContain('HANDMADE=1');
    expect(existsSync(join(path, '.ai', 'README.md'))).toBe(true);
    expect(gitIn(path, 'status', '--porcelain')).toBe('');
    expect(readFileSync(ctxOf(s).paths.audit, 'utf8')).toContain('"action":"refresh"');
  });

  it('recovers a setup-failed lane once the hook is fixed', async () => {
    const s = await setupContainer();
    writeHook(s.container, 'post-create', 'exit 1');
    await expect(runCreate({ container: s.container }, s.deps)).rejects.toBeInstanceOf(HookError);
    writeHook(s.container, 'post-create', 'true');
    await runRefresh({ lane: 'lane_1', container: s.container }, s.deps);
    expect(lane1(s)).toMatchObject({ state: 'active', status: 'idle' });
    expect(readLanes(ctxOf(s)).requests.filter((q) => q.lane === 'lane_1')).toEqual([]);
    expect(readFileSync(ctxOf(s).paths.board, 'utf8')).not.toContain('⚠️ setup-failed');
  });

  it('recovers a lane refused under policy approve once a human approves the hooks', async () => {
    const s = await setupContainer();
    setConfig(s.container, (c) => { c.hooks.policy = 'approve'; });
    writeHook(s.container, 'post-create', 'touch "$LANE_DIR/ran"');
    await expect(runCreate({ container: s.container }, s.deps)).rejects.toMatchObject({ exitCode: 3 });
    approveHooks(ctxOf(s).paths);
    await runRefresh({ lane: 'lane_1', container: s.container }, s.deps);
    expect(existsSync(join(s.container, 'lane_1', 'ran'))).toBe(true);
    expect(lane1(s).state).toBe('active');
  });

  it('marks the lane setup-failed when post-create fails on refresh', async () => {
    const s = await setupContainer();
    await runCreate({ container: s.container }, s.deps);
    writeHook(s.container, 'post-create', 'echo nope >&2; exit 2');
    const err = await runRefresh({ lane: 'lane_1', container: s.container }, s.deps).catch((e) => e);
    expect(err).toBeInstanceOf(HookError);
    expect(err.exitCode).toBe(1);
    expect(err.message).toContain('laines refresh lane_1');
    expect(lane1(s)).toMatchObject({ state: 'setup-failed', status: 'setup-failed' });
    expect(readLanes(ctxOf(s)).requests.map((q) => q.id)).toContain('setup-failed:lane_1');
  });

  it('a refusal under policy approve leaves .laines.env as it was and marks the lane setup-failed', async () => {
    const s = await setupContainer();
    setConfig(s.container, (c) => { c.hooks.policy = 'approve'; });
    writeHook(s.container, 'post-create', 'echo "DB=x" >> "$LANE_ENV_FILE"');
    approveHooks(ctxOf(s).paths);
    const { path } = await runCreate({ container: s.container }, s.deps);
    expect(readFileSync(join(path, '.laines.env'), 'utf8')).toContain('DB=x');
    writeHook(s.container, 'post-create', 'echo "DB=y" >> "$LANE_ENV_FILE"');
    const err = await runRefresh({ lane: 'lane_1', container: s.container }, s.deps).catch((e) => e);
    expect(err).toBeInstanceOf(HookError);
    expect(err.exitCode).toBe(3);
    expect(readFileSync(join(path, '.laines.env'), 'utf8')).toContain('DB=x');
    expect(lane1(s)).toMatchObject({ state: 'setup-failed', status: 'setup-failed' });
    expect(readLanes(ctxOf(s)).requests.find((q) => q.id === 'setup-failed:lane_1')).toMatchObject({
      command: 'laines hooks approve && laines refresh lane_1',
    });
  });

  it('a malformed hooks.lock.json fails before anything is written', async () => {
    const s = await setupContainer();
    const { path } = await runCreate({ container: s.container }, s.deps);
    writeFileSync(join(path, '.laines.env'), 'x\n');
    writeFileSync(ctxOf(s).paths.hooksLock, '{ not json');
    await expect(runRefresh({ lane: 'lane_1', container: s.container }, s.deps)).rejects.toBeInstanceOf(MalformedConfigError);
    expect(readFileSync(join(path, '.laines.env'), 'utf8')).toBe('x\n');
    expect(lane1(s).state).toBe('active');
  });

  it('rescues a lane left "spinning up" by an interrupted create', async () => {
    const s = await setupContainer();
    await runCreate({ container: s.container }, s.deps);
    await updateLanes(ctxOf(s), s.deps, (st) => {
      st.lanes.lane_1.status = 'spinning up';
      st.lanes.lane_1.updated = '2026-09-29T10:00:00.000Z';
      return { state: st, result: null };
    });
    await runRefresh({ lane: 'lane_1', container: s.container }, s.deps);
    expect(lane1(s)).toMatchObject({ state: 'active', status: 'idle' });
  });

  it('refuses a lane whose create may still be running', async () => {
    const s = await setupContainer();
    await runCreate({ container: s.container }, s.deps);
    await updateLanes(ctxOf(s), s.deps, (st) => {
      st.lanes.lane_1.status = 'spinning up';
      st.lanes.lane_1.updated = '2026-09-29T11:59:00.000Z';
      return { state: st, result: null };
    });
    const err = await runRefresh({ lane: 'lane_1', container: s.container }, s.deps).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidInputError);
    expect(err.message).toContain('still being created');
  });

  it('records the branch the clone is on now', async () => {
    const s = await setupContainer();
    const { path } = await runCreate({ container: s.container }, s.deps);
    gitIn(path, 'checkout', '-q', '-b', 'feat/x');
    const r = await runRefresh({ lane: 'lane_1', container: s.container }, s.deps);
    expect(r.branch).toBe('feat/x');
    expect(lane1(s).repos[0].branch).toBe('feat/x');
    expect(readFileSync(join(path, '.laines.env'), 'utf8')).toContain('LANE_BRANCH="feat/x"');
  });

  it('dry run lists hooks and changes nothing', async () => {
    const s = await setupContainer();
    const { path } = await runCreate({ container: s.container }, s.deps);
    writeHook(s.container, 'post-create', 'touch "$LANE_DIR/ran"');
    writeFileSync(join(path, '.laines.env'), 'x\n');
    const r = await runRefresh({ lane: 'lane_1', dryRun: true, container: s.container }, s.deps);
    expect(r).toMatchObject({ dryRun: true, lane: 'lane_1', hooks: { event: 'post-create', wouldRun: true } });
    expect(readFileSync(join(path, '.laines.env'), 'utf8')).toBe('x\n');
    expect(existsSync(join(path, 'ran'))).toBe(false);
  });

  it('refuses a closed lane and a lane whose clone is missing', async () => {
    const s = await setupContainer();
    await runCreate({ container: s.container }, s.deps);
    const two = await runCreate({ container: s.container }, s.deps);
    await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    await expect(runRefresh({ lane: 'lane_1', container: s.container }, s.deps)).rejects.toBeInstanceOf(InvalidInputError);
    rmSync(two.path, { recursive: true, force: true });
    await expect(runRefresh({ lane: 'lane_2', container: s.container }, s.deps)).rejects.toThrow(/laines teardown lane_2/);
  });

  it('wires into the CLI and finds the lane from inside it', async () => {
    const s = await setupContainer();
    const { path } = await runCreate({ container: s.container }, s.deps);
    const r = await runCli(['refresh', '--format', 'table'], { ...s.deps, cwd: () => path });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('lane lane_1 refreshed');
    expect(r.stdout).toContain('hooks:   post-create: no hooks');
  });
});
