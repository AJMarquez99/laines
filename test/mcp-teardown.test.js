import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCreate } from '../src/commands/create.js';
import { loadContainer } from '../src/lib/container.js';
import { readLanes } from '../src/lib/lanes-store.js';
import { invoke } from '../src/commands/registry.js';
import { declinedMessage, runTeardownMcp } from '../src/mcp/teardown.js';
import { BlockedError } from '../src/lib/errors.js';
import { cleanupTmp, connectMcp, setupContainer, setConfig, gitIn } from './helpers.js';

afterEach(cleanupTmp);

async function withLane(mode = 'confirm') {
  const s = await setupContainer();
  setConfig(s.container, (c) => { c.teardown.mcp = mode; });
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

  it('treats a cancelled tool call as no answer, even if the human accepts later', async () => {
    const s = await withLane();
    let answer;
    const answered = new Promise((resolve) => { answer = resolve; });
    const m = await connectMcp(s.deps, { container: s.container, elicit: async () => { await answered; return { action: 'accept', content: { confirm: true } }; } });
    const ac = new AbortController();
    const call = m.client.callTool({ name: 'laines_teardown', arguments: { lane: 'lane_1' } }, undefined, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    await expect(call).rejects.toThrow();
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

  it('refuses a kept lane or unpushed work before prompting anyone', async () => {
    const s = await withLane();
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
