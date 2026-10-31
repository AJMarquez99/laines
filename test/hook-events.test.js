import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadContainer } from '../src/lib/container.js';
import { approveHooks } from '../src/lib/hooks.js';
import { dryRunHooks, hookBoardEntries, hookError, lockSuggested, runEvent, runSummary, setupFailedRequest, unapprovedWarnings } from '../src/lib/hook-events.js';
import { dropRequests, emptyLanesState, putRequest } from '../src/lib/lanes-state.js';
import { HookError } from '../src/lib/errors.js';
import { laneHookVars } from '../src/lib/hook-events.js';
import { cleanupTmp, setupContainer, writeHook } from './helpers.js';

afterEach(cleanupTmp);

const LANE = { number: 1, repos: [{ name: 'my-app', path: 'lane_1', branch: 'main' }], ports: [20000, 20009] };

async function setup(policy = 'notify') {
  const s = await setupContainer();
  const ctx = loadContainer({ container: s.container }, s.deps);
  ctx.config.hooks.policy = policy;
  const laneDir = join(s.container, 'lane_1');
  mkdirSync(laneDir);
  const warnings = [];
  const deps = { ...s.deps, warn: (m) => warnings.push(m) };
  const run = (event = 'post-create') => runEvent(ctx, deps, { event, name: 'lane_1', lane: LANE, cwd: laneDir });
  return { ...s, ctx, deps, laneDir, run, warnings };
}

describe('runEvent', () => {
  it('succeeds with no hooks', async () => {
    const { run } = await setup();
    const r = await run();
    expect(r).toMatchObject({ event: 'post-create', outcome: 'ok', results: [], unapproved: [], error: null });
    expect(runSummary(r)).toBe('no hooks');
  });

  it('gives hooks the contract environment, in the working directory it was given', async () => {
    const { container, laneDir, run } = await setup();
    writeHook(container, 'post-create', 'env > env.txt; pwd -P > pwd.txt');
    expect((await run()).outcome).toBe('ok');
    const env = Object.fromEntries(
      readFileSync(join(laneDir, 'env.txt'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    expect(env).toMatchObject({
      LAINES_HOOK: 'post-create', LAINES_DRY_RUN: '0', LANE_NAME: 'lane_1', LANE_NUMBER: '1', LANE_ID: 'my-app/lane_1',
      LANE_DIR: laneDir, CONTAINER_DIR: container, CONTAINER_ID: 'my-app', LANE_PORT_BASE: '20000', LANE_PORT_COUNT: '10',
      LANE_SUFFIX: '_my_app_l1', LANE_BRANCH: 'main', LANE_ENV_FILE: join(laneDir, '.laines.env'), PORT: '20000', COMPOSE_PROJECT_NAME: 'my-app-l1',
    });
    expect(readFileSync(join(laneDir, 'pwd.txt'), 'utf8').trim()).toBe(laneDir);
  });

  it('runs the main hook then <event>.d/ in order, and stops at the first failure', async () => {
    const { container, laneDir, run } = await setup();
    writeHook(container, 'post-create', 'echo main >> order.txt');
    writeHook(container, 'post-create.d/10-a', 'echo a >> order.txt');
    writeHook(container, 'post-create.d/20-b', 'echo b >> order.txt; echo "b broke" >&2; exit 1');
    writeHook(container, 'post-create.d/30-c', 'echo c >> order.txt');
    const r = await run();
    expect(readFileSync(join(laneDir, 'order.txt'), 'utf8')).toBe('main\na\nb\n');
    expect(r.outcome).toBe('failed');
    expect(r.results.map((x) => [x.hook, x.status])).toEqual([['post-create', 0], ['post-create.d/10-a', 0], ['post-create.d/20-b', 1]]);
    expect(r.results[2]).toMatchObject({ untrusted: true });
    expect(r.results[2].output).toContain('b broke');
    expect(runSummary(r)).toBe('post-create.d/20-b exited 1');
    const err = hookError(r, 'Fix it.');
    expect(err).toBeInstanceOf(HookError);
    expect(err.message.split('\n')[0]).toBe('post-create: post-create.d/20-b exited 1.');
    expect(setupFailedRequest(r, 'lane_1', 't').text).toBe('post-create: post-create.d/20-b exited 1');
    expect(err.exitCode).toBe(1);
    expect(err.run).toBe(r);
    expect(err.message).toContain("Hook output (untrusted: printed by the project's hook script):");
    expect(err.message).toContain('b broke');
    expect(err.message.endsWith('Fix it.')).toBe(true);
  });

  it('treats exit 3 as blocked on a human, not a failure', async () => {
    const { container, run } = await setup();
    writeHook(container, 'post-create', 'echo "start Postgres first"; exit 3');
    const r = await run();
    expect(r.outcome).toBe('blocked');
    expect(runSummary(r)).toBe('post-create exited 3 (needs a human)');
    expect(hookError(r, 'x').exitCode).toBe(3);
  });

  it('fails a hook without the executable bit with a chmod hint, without running it', async () => {
    const { container, laneDir, run } = await setup();
    writeHook(container, 'post-create', 'touch ran', { mode: 0o644 });
    const r = await run();
    expect(r.outcome).toBe('failed');
    expect(r.results[0]).toMatchObject({ status: null, untrusted: false });
    expect(r.results[0].output).toContain('chmod +x');
    expect(existsSync(join(laneDir, 'ran'))).toBe(false);
    expect(runSummary(r)).toBe('post-create could not run');
  });

  it('names a missing interpreter on the #! line, without labelling it hook output', async () => {
    const { container, run } = await setup();
    const file = writeHook(container, 'post-create', 'true');
    writeFileSync(file, '#!/nonexistent/interpreter\ntrue\n');
    chmodSync(file, 0o755);
    const r = await run();
    expect(r.outcome).toBe('failed');
    expect(r.results[0]).toMatchObject({ status: null, untrusted: false });
    expect(r.results[0].output).toBe(`${file} could not start: the interpreter on its #! line was not found.`);
  });

  it('names a hook with no #! line, without labelling it hook output', async () => {
    const { container, run } = await setup();
    const file = writeHook(container, 'post-create', 'true');
    writeFileSync(file, 'echo no shebang\n');
    chmodSync(file, 0o755);
    const r = await run();
    expect(r.outcome).toBe('failed');
    expect(r.results[0]).toMatchObject({ status: null, untrusted: false });
    expect(r.results[0].output).toBe(`${file} could not start: it has no #! line.`);
  });

  it('stops a hook that runs past hooks.timeoutSec', async () => {
    const { container, ctx, run } = await setup();
    ctx.config.hooks.timeoutSec = 1;
    writeHook(container, 'post-create', 'sleep 20');
    const r = await run();
    expect(r.outcome).toBe('failed');
    expect(r.results[0].timedOut).toBe(true);
    expect(runSummary(r)).toBe('post-create timed out after 1s');
  });

  it('policy notify runs new and changed hooks, with an audit entry and a warning line each', async () => {
    const { container, ctx, run } = await setup('notify');
    writeHook(container, 'post-create', 'true');
    const r = await run();
    expect(r.outcome).toBe('ok');
    expect(r.unapproved).toEqual([{ hook: 'post-create', state: 'new', checksum: expect.stringMatching(/^sha256:/) }]);
    expect(unapprovedWarnings(r)).toEqual([expect.stringMatching(/hook post-create is new and ran unapproved \(policy notify\)/)]);
    expect(readFileSync(ctx.paths.audit, 'utf8')).toContain('"action":"hook-unapproved"');
  });

  it('policy approve refuses new and changed hooks with their diffs, running none', async () => {
    const { container, ctx, laneDir, run } = await setup('approve');
    writeHook(container, 'post-create', 'touch ran');
    const refused = await run();
    expect(refused.outcome).toBe('refused');
    expect(refused.results).toEqual([]);
    expect(existsSync(join(laneDir, 'ran'))).toBe(false);
    expect(refused.diffs[0]).toMatchObject({ hook: 'post-create', state: 'new' });
    expect(refused.diffs[0].diff).toContain('+touch ran');
    const err = hookError(refused, 'Ask a human.');
    expect(err.exitCode).toBe(3);
    expect(err.message).toContain('+touch ran');

    approveHooks(ctx.paths);
    expect((await run()).outcome).toBe('ok');
    expect(existsSync(join(laneDir, 'ran'))).toBe(true);

    writeHook(container, 'post-create', 'touch ran2');
    const changed = await run();
    expect(changed.outcome).toBe('refused');
    expect(changed.diffs[0].diff).toContain('-touch ran');
    expect(changed.diffs[0].diff).toContain('+touch ran2');
  });

  it('policy open runs hooks without any check', async () => {
    const { container, run, warnings } = await setup('open');
    writeHook(container, 'post-create', 'true');
    const r = await run();
    expect(r).toMatchObject({ outcome: 'ok', unapproved: [] });
    expect(r.results).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it('under notify, does not warn about unapproved hooks that never ran due to earlier failure', async () => {
    const { container, ctx, run } = await setup('notify');
    writeHook(container, 'post-create', 'exit 1');
    approveHooks(ctx.paths);
    expect((await run()).outcome).toBe('failed');
    writeHook(container, 'post-create.d/10-x', 'echo x');
    const r = await run();
    expect(r.outcome).toBe('failed');
    expect(r.unapproved).toEqual([{ hook: 'post-create.d/10-x', state: 'new', checksum: expect.stringMatching(/^sha256:/) }]);
    expect(unapprovedWarnings(r)).toEqual([]);
    const b = hookBoardEntries(r, { lane: 'lane_1', now: '2026-09-29T12:00:00.000Z' });
    expect(b.activity).toEqual([]);
    expect(b.requests).toEqual([]);
  });

  it('reports a malformed hooks.lock.json as a failed run instead of throwing', async () => {
    const { ctx, run } = await setup();
    writeFileSync(ctx.paths.hooksLock, '{');
    const r = await run();
    expect(r.outcome).toBe('failed');
    expect(r.error).toContain('Malformed file');
    expect(runSummary(r)).toMatch(/^could not check hooks: Malformed file/);
  });
});

describe('dryRunHooks', () => {
  it('lists what would run and whether the policy would refuse it', async () => {
    const { container, ctx } = await setup('approve');
    writeHook(container, 'post-create', 'true');
    expect(dryRunHooks(ctx, 'post-create')).toMatchObject({ event: 'post-create', policy: 'approve', wouldRun: false, refused: true, hooks: [{ hook: 'post-create', state: 'new' }] });
    ctx.config.hooks.policy = 'notify';
    expect(dryRunHooks(ctx, 'post-create')).toMatchObject({ wouldRun: true, refused: false });
    expect(dryRunHooks(ctx, 'pre-teardown')).toMatchObject({ wouldRun: false, refused: false, hooks: [] });
  });
});

describe('board entries and requests', () => {
  it('turns unapproved hooks into an activity line with the checksum and one container-wide request', async () => {
    const { container, run } = await setup('notify');
    writeHook(container, 'post-create', 'true');
    const r = await run();
    const b = hookBoardEntries(r, { lane: 'lane_1', now: '2026-09-29T12:00:00.000Z' });
    expect(b.activity).toHaveLength(1);
    expect(b.activity[0].text).toMatch(/unapproved hook\(s\) ran under policy notify: post-create \(new, sha256:[0-9a-f]{12}\)/);
    expect(b.requests).toEqual([expect.objectContaining({ lane: null, kind: 'hooks-changed', command: 'laines hooks approve' })]);
    expect(b.requests[0].text).toBe('hooks changed since the last approval: review them with `laines hooks status`');
    expect(hookBoardEntries({ ...r, unapproved: [] }, { lane: 'lane_1', now: 'x' })).toEqual({ activity: [], requests: [] });
  });

  it('putRequest keeps one request per kind and lane, newest first; dropRequests removes matches', () => {
    let s = emptyLanesState();
    s = putRequest(s, { ts: 't1', lane: 'lane_1', kind: 'setup-failed', text: 'a', command: 'c' });
    s = putRequest(s, { ts: 't2', kind: 'hooks-changed', text: 'b', command: 'c' });
    s = putRequest(s, { ts: 't3', lane: 'lane_1', kind: 'setup-failed', text: 'a2', command: 'c' });
    expect(s.requests.map((q) => [q.id, q.text])).toEqual([['setup-failed:lane_1', 'a2'], ['hooks-changed:*', 'b']]);
    expect(dropRequests(s, (q) => q.lane === 'lane_1').requests.map((q) => q.id)).toEqual(['hooks-changed:*']);
  });
});

describe('lockSuggested', () => {
  const config = (policy = 'notify') => ({ hooks: { policy, stableAfter: 2 } });
  const history = (...sets) => ({ ...emptyLanesState(), hookHistory: sets.map((checksums, i) => ({ ts: `t${i}`, checksums })) });
  const A = { 'post-create': 'sha256:a' };
  const B = { 'post-create': 'sha256:b' };

  it('suggests a lock once the last stableAfter creates saw the current, non-empty hook set', () => {
    expect(lockSuggested(history(B, A, A), config(), A)).toBe(true);
    expect(lockSuggested(history(A), config(), A)).toBe(false);
    expect(lockSuggested(history(A, B), config(), B)).toBe(false);
    expect(lockSuggested(history(A, A), config(), B)).toBe(false);
    expect(lockSuggested(history(A, A), config('approve'), A)).toBe(false);
    expect(lockSuggested(history({}, {}), config(), {})).toBe(false);
  });
});

describe('laneHookVars', () => {
  it("uses the lane's recorded compose name, else <id>-l<n>", async () => {
    const s = await setupContainer();
    const ctx = loadContainer({ container: s.container }, s.deps);
    expect(laneHookVars(ctx, 'lane_1', { ...LANE, compose: 'myapp' }).COMPOSE_PROJECT_NAME).toBe('myapp');
    expect(laneHookVars(ctx, 'lane_1', LANE).COMPOSE_PROJECT_NAME).toBe(`${ctx.id}-l1`);
  });

  it('has no PORT for an adopted lane, and still has LANE_PORT_BASE', async () => {
    const s = await setupContainer();
    const ctx = loadContainer({ container: s.container }, s.deps);
    const vars = laneHookVars(ctx, 'lane_1', { ...LANE, adopted: true });
    expect('PORT' in vars).toBe(false);
    expect(vars.LANE_PORT_BASE).toBe(String(LANE.ports[0]));
    expect(laneHookVars(ctx, 'lane_1', LANE).PORT).toBe(String(LANE.ports[0]));
    // A hand-edited `adopted: false` is the same as no flag.
    expect(laneHookVars(ctx, 'lane_1', { ...LANE, adopted: false }).PORT).toBe(String(LANE.ports[0]));
  });
});
