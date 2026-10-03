import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { invoke } from '../src/commands/registry.js';
import { cleanupTmp, connectMcp, setupContainer, writeHook } from './helpers.js';

afterEach(cleanupTmp);

describe('audit coverage (spec §9.1)', () => {
  it('records every side-effecting command, from the CLI layer and from MCP', async () => {
    const s = await setupContainer();
    const c = { container: s.container };
    writeHook(s.container, 'post-create', 'true');
    await invoke('create', { ...c }, s.deps);
    const m = await connectMcp(s.deps, { container: s.container });
    await m.call('laines_create');
    await m.close();
    await invoke('refresh', { lane: 'lane_1', ...c }, s.deps);
    await invoke('keep', { lane: 'lane_1', reason: 'x', ...c }, s.deps);
    await invoke('release', { lane: 'lane_1', ...c }, s.deps);
    await invoke('hooks approve', { ...c }, s.deps);
    await invoke('hooks policy', { policy: 'open', ...c }, s.deps);
    await invoke('config set', { key: 'board.logLimit', value: '50', ...c }, s.deps);
    await invoke('teardown', { lane: 'lane_1', ...c }, s.deps);
    const entries = readFileSync(join(s.container, '.laines', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const actions = entries.map((e) => e.action);
    for (const a of ['init', 'create', 'refresh', 'keep', 'release', 'hooks-approve', 'hooks-policy', 'config-set', 'teardown', 'hook-unapproved']) {
      expect(actions, a).toContain(a);
    }
    expect(actions.filter((a) => a === 'create')).toHaveLength(2);
    for (const e of entries) expect(Object.keys(e)).not.toContain('output');
  });
});
