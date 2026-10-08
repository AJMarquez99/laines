import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCreate } from '../src/commands/create.js';
import { loadContainer } from '../src/lib/container.js';
import { readLanes } from '../src/lib/lanes-store.js';
import { invoke } from '../src/commands/registry.js';
import { declinedMessage, runTeardownMcp } from '../src/mcp/teardown.js';
import { BlockedError } from '../src/lib/errors.js';
import { cleanupTmp, connectMcp, setupContainer, setConfig, gitIn } from './helpers.js';

afterEach(cleanupTmp);

async function withLane(mode = 'confirm', force = 'confirm') {
  const s = await setupContainer();
  setConfig(s.container, (c) => { c.teardown.mcp = mode; c.teardown.mcpForce = force; });
  const lane = await runCreate({ container: s.container }, s.deps);
  const state = () => readLanes(loadContainer({ container: s.container }, s.deps));
  return { ...s, dir: lane.path, state };
}

const neverPrompted = () => {
  throw new Error('the human must not be prompted');
};

describe('teardown over MCP: confirm', () => {
  it('asks the human with a summary and tears down on confirm', async () => {
    const s = await withLane();
    writeFileSync(join(s.dir, '.ai', 'plans', 'task.md'), 'plan\n');
    const prompts = [];
    const m = await connectMcp(s.deps, { container: s.container, elicit: (p) => (prompts.push(p), { action: 'accept', content: { confirm: true } }) });
    const r = await m.call('laines_teardown', { lane: 'lane_1' });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ lane: 'lane_1', removedDir: false });
    expect(prompts).toHaveLength(1);
    for (const part of ['lane_1', 'Branch: main', 'Unpushed work', 'stacked PRs']) expect(prompts[0].message).toContain(part);
    expect(prompts[0].requestedSchema.properties.confirm.type).toBe('boolean');
    expect(s.state().lanes.lane_1.state).toBe('closed');
    await m.close();
  });

  it('does nothing on decline, cancel, an unchecked box, or a failed prompt', async () => {
    const s = await withLane();
    const answers = [
      () => ({ action: 'decline' }),
      () => ({ action: 'cancel' }),
      () => ({ action: 'accept', content: { confirm: false } }),
      () => {
        throw new Error('client broke');
      },
    ];
    for (const answer of answers) {
      const m = await connectMcp(s.deps, { container: s.container, elicit: answer });
      const r = await m.call('laines_teardown', { lane: 'lane_1', remove_dir: true });
      expect(r.isError).toBe(true);
      expect(r.structuredContent.error).toEqual({ exitCode: 3, message: declinedMessage('lane_1') });
      await m.close();
    }
    expect(s.state().lanes.lane_1.state).toBe('active');
  });

  it('leaves a board request when the client cannot ask a human', async () => {
    const s = await withLane();
    const m = await connectMcp(s.deps, { container: s.container });
    const r = await m.call('laines_teardown', { lane: 'lane_1', remove_dir: true });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error.exitCode).toBe(3);
    expect(r.structuredContent.error.message).toContain('laines teardown lane_1 --remove-dir');
    expect(s.state().requests.find((q) => q.id === 'teardown-confirm:lane_1')).toMatchObject({ command: 'laines teardown lane_1 --remove-dir' });
    expect(s.state().lanes.lane_1.state).toBe('active');
    await invoke('teardown', { lane: 'lane_1', removeDir: true, container: s.container }, s.deps);
    expect(s.state().requests.filter((q) => q.lane === 'lane_1')).toEqual([]);
    await m.close();
  });

  it('leaves a board request when the client offers only URL elicitation', async () => {
    const s = await withLane();
    const m = await connectMcp(s.deps, { container: s.container, capabilities: { elicitation: { url: {} } }, elicit: neverPrompted });
    const r = await m.call('laines_teardown', { lane: 'lane_1' });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error.exitCode).toBe(3);
    expect(r.structuredContent.error.message).not.toContain('Declined');
    expect(s.state().requests.map((q) => q.id)).toContain('teardown-confirm:lane_1');
    expect(s.state().lanes.lane_1.state).toBe('active');
    await m.close();
  });

  it('treats a cancelled tool call as no answer, even if the human accepts later', async () => {
    const s = await withLane();
    let answer;
    let entered;
    const answered = new Promise((resolve) => { answer = resolve; });
    const prompted = new Promise((resolve) => { entered = resolve; });
    const m = await connectMcp(s.deps, { container: s.container, elicit: async () => { entered(); await answered; return { action: 'accept', content: { confirm: true } }; } });
    const ac = new AbortController();
    const call = m.client.callTool({ name: 'laines_teardown', arguments: { lane: 'lane_1' } }, undefined, { signal: ac.signal });
    await prompted;
    ac.abort();
    await expect(call).rejects.toThrow(/abort/i);
    answer();
    await new Promise((r) => setTimeout(r, 300));
    expect(s.state().lanes.lane_1.state).toBe('active');
    await m.close();
  });

  it('a human who keeps the lane instead withdraws the teardown request', async () => {
    const s = await withLane();
    const m = await connectMcp(s.deps, { container: s.container });
    await m.call('laines_teardown', { lane: 'lane_1' });
    expect(s.state().requests.map((q) => q.id)).toContain('teardown-confirm:lane_1');
    await invoke('keep', { lane: 'lane_1', reason: 'still needed', container: s.container }, s.deps);
    expect(s.state().requests.filter((q) => q.lane === 'lane_1')).toEqual([]);
    await m.close();
  });

  it('refuses a kept lane or unpushed work before prompting anyone (mcpForce off)', async () => {
    const s = await withLane('confirm', 'off');
    const m = await connectMcp(s.deps, { container: s.container, elicit: neverPrompted });
    gitIn(s.dir, 'commit', '-q', '--allow-empty', '-m', 'local only');
    const unpushed = await m.call('laines_teardown', { lane: 'lane_1', remove_dir: true });
    expect(unpushed.structuredContent.error.exitCode).toBe(3);
    expect(unpushed.structuredContent.error.message).toContain('exist on no remote');
    await invoke('keep', { lane: 'lane_1', reason: 'base of PR #1', container: s.container }, s.deps);
    const kept = await m.call('laines_teardown', { lane: 'lane_1' });
    expect(kept.structuredContent.error.message).toContain('is kept');
    expect(s.state().lanes.lane_1.state).toBe('active');
    await m.close();
  });

  // Relies on unpushedWork running `git status --porcelain` before `rev-list`: the second status
  // call is the post-prompt re-check, so the push lands between the first check and the re-check.
  it('never runs the real teardown without an accept, even if the work gets pushed after the check', async () => {
    const s = await withLane('confirm', 'off');
    gitIn(s.dir, 'commit', '-q', '--allow-empty', '-m', 'local only');
    let statuses = 0;
    const prompts = [];
    const deps = {
      ...s.deps,
      canElicit: () => true,
      elicit: async (message) => (prompts.push(message), { action: 'accept', content: { confirm: true } }),
      git: (args, o) => {
        if (args[0] === 'status' && args.includes('--porcelain') && (statuses += 1) === 2) gitIn(s.dir, 'push', '-q', 'origin', 'HEAD');
        return s.deps.git(args, o);
      },
    };
    await expect(runTeardownMcp({ lane: 'lane_1', removeDir: true, container: s.container }, deps)).rejects.toMatchObject({ exitCode: 3, message: expect.stringContaining('exist on no remote') });
    expect(prompts).toEqual([]);
    expect(s.state().lanes.lane_1.state).toBe('active');
    expect(existsSync(s.dir)).toBe(true);
  });

  it('cannot be forced: an injected force argument is dropped', async () => {
    const s = await withLane('auto');
    gitIn(s.dir, 'commit', '-q', '--allow-empty', '-m', 'local only');
    const m = await connectMcp(s.deps, { container: s.container, elicit: neverPrompted });
    const r = await m.call('laines_teardown', { lane: 'lane_1', remove_dir: true, force: true });
    expect(r.structuredContent.error.exitCode).toBe(3);
    expect(s.state().lanes.lane_1.state).toBe('active');
    await m.close();
  });

  it('respects the teardown capability before prompting', async () => {
    const s = await withLane();
    setConfig(s.container, (c) => { c.capabilities.teardown = false; });
    const m = await connectMcp(s.deps, { container: s.container, elicit: neverPrompted });
    expect((await m.call('laines_teardown', { lane: 'lane_1' })).structuredContent.error.exitCode).toBe(4);
    await m.close();
  });
});

describe('teardown over MCP: auto and off', () => {
  it('auto tears down without a prompt', async () => {
    const s = await withLane('auto');
    const m = await connectMcp(s.deps, { container: s.container, elicit: neverPrompted });
    const r = await m.call('laines_teardown', { lane: 'lane_1' });
    expect(r.isError).toBeFalsy();
    expect(s.state().lanes.lane_1.state).toBe('closed');
    await m.close();
  });

  it('off does not register the tool, and refuses if called directly', async () => {
    const s = await withLane('off');
    const m = await connectMcp(s.deps, { container: s.container });
    const { tools } = await m.client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('laines_teardown');
    await expect(runTeardownMcp({ lane: 'lane_1', container: s.container }, s.deps)).rejects.toBeInstanceOf(BlockedError);
    await m.close();
  });

  it('dry run reports without prompting', async () => {
    const s = await withLane();
    const m = await connectMcp(s.deps, { container: s.container, elicit: neverPrompted });
    const r = await m.call('laines_teardown', { lane: 'lane_1', dry_run: true });
    expect(r.structuredContent).toMatchObject({ dryRun: true, lane: 'lane_1' });
    await m.close();
  });
});

describe('teardown over MCP: forced after a typed confirmation', () => {
  const NOT_CONFIRMED = 'Not confirmed: nothing was torn down.';
  async function blockedLane(mode = 'confirm', force = 'confirm') {
    const s = await withLane(mode);
    setConfig(s.container, (c) => { c.teardown.mcpForce = force; });
    gitIn(s.dir, 'commit', '-q', '--allow-empty', '-m', 'local only work');
    return s;
  }
  // Answers the confirm form, then the typed form; `second` may run side effects first.
  const responder = (prompts, first, second) => (p) => {
    prompts.push(p);
    return p.requestedSchema.properties.confirm ? first : second(p);
  };
  const yes = { action: 'accept', content: { confirm: true } };
  const typed = (lane) => ({ action: 'accept', content: { lane } });
  const audit = (s) => readFileSync(join(s.container, '.laines', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  it('forces after the first accept and the typed lane name', async () => {
    const s = await blockedLane();
    const prompts = [];
    const m = await connectMcp(s.deps, { container: s.container, elicit: responder(prompts, yes, () => typed(' lane_1 ')) });
    const r = await m.call('laines_teardown', { lane: 'lane_1', remove_dir: true });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ forced: true, removedDir: true });
    expect(existsSync(s.dir)).toBe(false);
    expect(prompts).toHaveLength(2);
    expect(prompts[0].message).toContain('type the lane name');
    expect(prompts[1].message).toContain('local only work');
    expect(prompts[1].message).toContain('held by no other lane');
    expect(prompts[1].requestedSchema).toMatchObject({ properties: { lane: { type: 'string' } }, required: ['lane'] });
    expect(audit(s).find((e) => e.action === 'teardown')).toMatchObject({ forced: true, forcedVia: 'mcp-typed-confirmation', discarded: [expect.stringContaining('exist on no remote')] });
    expect(s.state().activity.map((a) => a.text).join('\n')).toContain('forced after a typed confirmation');
    await m.close();
  });

  it.each([
    ['a wrong name', () => typed('lane_2'), /did not match/],
    ['an empty name', () => typed(''), /Not confirmed/],
    ['a decline', () => ({ action: 'decline' }), /Not confirmed/],
    ['a cancel', () => ({ action: 'cancel' }), /Not confirmed/],
    ['a failed prompt', () => { throw new Error('timeout'); }, /Not confirmed/],
  ])('refuses on the second form with %s', async (_n, second, text) => {
    const s = await blockedLane();
    const m = await connectMcp(s.deps, { container: s.container, elicit: responder([], yes, second) });
    const r = await m.call('laines_teardown', { lane: 'lane_1', remove_dir: true });
    expect(r.structuredContent.error.exitCode).toBe(3);
    expect(r.structuredContent.error.message).toMatch(text);
    expect(r.structuredContent.error.message).toContain(NOT_CONFIRMED);
    expect(existsSync(s.dir)).toBe(true);
    expect(s.state().lanes.lane_1.state).toBe('active');
    await m.close();
  });

  it('refuses when the human declines the first form', async () => {
    const s = await blockedLane();
    const prompts = [];
    const m = await connectMcp(s.deps, { container: s.container, elicit: responder(prompts, { action: 'decline' }, () => typed('lane_1')) });
    const r = await m.call('laines_teardown', { lane: 'lane_1', remove_dir: true });
    expect(r.structuredContent.error.exitCode).toBe(3);
    expect(prompts).toHaveLength(1);
    expect(existsSync(s.dir)).toBe(true);
    await m.close();
  });

  it('refuses when the unpushed work changes after the human was shown it', async () => {
    const s = await blockedLane();
    const second = () => {
      gitIn(s.dir, 'commit', '-q', '--allow-empty', '-m', 'agent committed again');
      return typed('lane_1');
    };
    const m = await connectMcp(s.deps, { container: s.container, elicit: responder([], yes, second) });
    const r = await m.call('laines_teardown', { lane: 'lane_1', remove_dir: true });
    expect(r.structuredContent.error.exitCode).toBe(3);
    expect(r.structuredContent.error.message).toMatch(/changed/);
    expect(existsSync(s.dir)).toBe(true);
    expect(s.state().lanes.lane_1.state).toBe('active');
    await m.close();
  });

  it.each([
    ['mcpForce off', async (s) => setConfig(s.container, (c) => { c.teardown.mcpForce = 'off'; })],
    ['a locked container', async (s) => setConfig(s.container, (c) => { c.locked = true; })],
  ])('never shows the second form with %s', async (_n, arrange) => {
    const s = await blockedLane();
    await arrange(s);
    const m = await connectMcp(s.deps, { container: s.container, elicit: neverPrompted });
    const r = await m.call('laines_teardown', { lane: 'lane_1', remove_dir: true });
    expect(r.structuredContent.error.exitCode).toBe(3);
    expect(r.structuredContent.error.message).toContain('exist on no remote');
    expect(existsSync(s.dir)).toBe(true);
    await m.close();
  });

  it('leaves a kept lane refused and a non-eliciting client on the board', async () => {
    const s = await blockedLane();
    const m = await connectMcp(s.deps, { container: s.container });
    const r = await m.call('laines_teardown', { lane: 'lane_1', remove_dir: true });
    expect(r.structuredContent.error.message).toContain('exist on no remote');
    await invoke('keep', { lane: 'lane_1', reason: 'base', container: s.container }, s.deps);
    const k = await connectMcp(s.deps, { container: s.container, elicit: neverPrompted });
    expect((await k.call('laines_teardown', { lane: 'lane_1', remove_dir: true })).structuredContent.error.message).toContain('is kept');
    await m.close();
    await k.close();
  });

  it('declares no force in any tool schema and drops an injected expect', async () => {
    const s = await blockedLane();
    const m = await connectMcp(s.deps, { container: s.container, elicit: neverPrompted });
    const { tools } = await m.client.listTools();
    for (const t of tools) expect(Object.keys(t.inputSchema.properties ?? {})).not.toContain('force');
    await m.close();
  });
});
