import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCreate } from '../src/commands/create.js';
import { runHooksApprove, runHooksPolicy, runHooksStatus } from '../src/commands/hooks.js';
import { loadContainer } from '../src/lib/container.js';
import { readLanes } from '../src/lib/lanes-store.js';
import { InvalidInputError } from '../src/lib/errors.js';
import { cleanupTmp, setupContainer, runCli, writeHook, setConfig } from './helpers.js';

afterEach(cleanupTmp);

const ctxOf = (s) => loadContainer({ container: s.container }, s.deps);
const config = (s) => JSON.parse(readFileSync(join(s.container, '.laines', 'config.json'), 'utf8'));

describe('hooks status', () => {
  it('reports each hook with its state, diff and executable bit', async () => {
    const s = await setupContainer();
    writeHook(s.container, 'post-create', 'echo one');
    writeHook(s.container, 'pre-teardown', 'echo two', { mode: 0o644 });
    const r = await runHooksStatus({ container: s.container }, s.deps);
    expect(r).toMatchObject({ policy: 'notify', removed: [], lockSuggested: false });
    expect(r.hooks.map((h) => [h.hook, h.event, h.state, h.executable])).toEqual([['post-create', 'post-create', 'new', true], ['pre-teardown', 'pre-teardown', 'new', false]]);
    expect(r.hooks[0].diff).toContain('+echo one');
  });

  it('suggests a lock once creates have seen a stable hook set', async () => {
    const s = await setupContainer();
    setConfig(s.container, (c) => { c.hooks.stableAfter = 1; });
    writeHook(s.container, 'post-create', 'true');
    await runCreate({ container: s.container }, s.deps);
    expect((await runHooksStatus({ container: s.container }, s.deps)).lockSuggested).toBe(true);
  });
});

describe('hooks approve', () => {
  it('approves the current hooks, clears the approval request, and logs it', async () => {
    const s = await setupContainer();
    writeHook(s.container, 'post-create', 'true');
    await runCreate({ container: s.container }, s.deps);
    expect(readLanes(ctxOf(s)).requests.map((q) => q.id)).toContain('hooks-changed:*');
    const r = await runHooksApprove({ container: s.container }, s.deps);
    expect(r).toMatchObject({ dryRun: false, policy: 'notify', removed: [] });
    expect(r.approved).toEqual([{ hook: 'post-create', checksum: expect.stringMatching(/^sha256:/), was: 'new', diff: expect.stringContaining('+true') }]);
    expect(readLanes(ctxOf(s)).requests).toEqual([]);
    expect((await runHooksStatus({ container: s.container }, s.deps)).hooks[0]).toMatchObject({ state: 'approved' });
    expect(readFileSync(ctxOf(s).paths.audit, 'utf8')).toContain('"action":"hooks-approve"');
    expect(readFileSync(ctxOf(s).paths.board, 'utf8')).toContain('hooks approved: post-create');
  });

  it('--lock also sets policy approve and clears the lock suggestion', async () => {
    const s = await setupContainer();
    setConfig(s.container, (c) => { c.hooks.stableAfter = 1; });
    writeHook(s.container, 'post-create', 'true');
    await runCreate({ container: s.container }, s.deps);
    expect(readLanes(ctxOf(s)).requests.map((q) => q.id)).toContain('hooks-lock:*');
    const r = await runHooksApprove({ lock: true, container: s.container }, s.deps);
    expect(r.policy).toBe('approve');
    expect(config(s).hooks.policy).toBe('approve');
    expect(readLanes(ctxOf(s)).requests).toEqual([]);
    expect(readFileSync(ctxOf(s).paths.board, 'utf8')).toContain('hook policy: approve');
  });

  it('dry run reports what would be approved and approves nothing', async () => {
    const s = await setupContainer();
    writeHook(s.container, 'post-create', 'true');
    const r = await runHooksApprove({ dryRun: true, lock: true, container: s.container }, s.deps);
    expect(r).toMatchObject({ dryRun: true, lock: true, approve: [{ hook: 'post-create', state: 'new' }] });
    expect(r.approve[0].diff).toContain('+true');
    expect((await runHooksStatus({ container: s.container }, s.deps)).hooks[0].state).toBe('new');
    expect(config(s).hooks.policy).toBe('notify');
  });
});

describe('hooks policy', () => {
  it('changes the policy, re-renders the board header and audits the change', async () => {
    const s = await setupContainer();
    const r = await runHooksPolicy({ policy: 'open', container: s.container }, s.deps);
    expect(r).toEqual({ dryRun: false, from: 'notify', to: 'open', changed: true });
    expect(config(s).hooks.policy).toBe('open');
    expect(readFileSync(ctxOf(s).paths.board, 'utf8')).toContain('hook policy: open');
    expect(readFileSync(ctxOf(s).paths.audit, 'utf8')).toContain('"action":"hooks-policy"');
  });

  it('rejects an unknown policy, and does nothing when unchanged or on a dry run', async () => {
    const s = await setupContainer();
    await expect(runHooksPolicy({ policy: 'yolo', container: s.container }, s.deps)).rejects.toBeInstanceOf(InvalidInputError);
    expect(await runHooksPolicy({ policy: 'notify', container: s.container }, s.deps)).toMatchObject({ changed: false });
    expect(await runHooksPolicy({ policy: 'approve', dryRun: true, container: s.container }, s.deps)).toEqual({ dryRun: true, from: 'notify', to: 'approve', changed: true });
    expect(config(s).hooks.policy).toBe('notify');
    expect(readFileSync(ctxOf(s).paths.audit, 'utf8')).not.toContain('hooks-policy');
  });
});

describe('hooks CLI', () => {
  it('wires status, approve and policy, and rejects options placed before the subcommand', async () => {
    const s = await setupContainer();
    const status = await runCli(['hooks', 'status', '--container', s.container], s.deps);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ policy: 'notify', hooks: [] });
    const bypass = await runCli(['hooks', '--format', 'json', 'policy', 'open', '--container', s.container], s.deps);
    expect(bypass.code).toBe(2);
    expect(config(s).hooks.policy).toBe('notify');
    const set = await runCli(['hooks', 'policy', 'open', '--container', s.container, '--format', 'table'], s.deps);
    expect(set.code).toBe(0);
    expect(set.stdout).toContain('hook policy notify → open');
    const approve = await runCli(['hooks', 'approve', '--container', s.container, '--format', 'table'], s.deps);
    expect(approve.code).toBe(0);
    expect(approve.stdout).toContain('approved 0 hook(s)');
  });

  it('refuses a bare -- so subcommands cannot dodge prefix-matched deny rules', async () => {
    const s = await setupContainer();
    writeHook(s.container, 'post-create', 'true');
    const a = await runCli(['hooks', '--', 'approve', '--container', s.container], s.deps);
    expect(a.code).toBe(2);
    expect((await runHooksStatus({ container: s.container }, s.deps)).hooks[0].state).toBe('new');
    const p = await runCli(['hooks', '--', 'policy', 'open', '--container', s.container], s.deps);
    expect(p.code).toBe(2);
    expect(config(s).hooks.policy).toBe('notify');
  });
});
