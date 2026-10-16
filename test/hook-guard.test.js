import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invoke } from '../src/commands/registry.js';
import { readLanes } from '../src/lib/lanes-store.js';
import { containerPaths } from '../src/lib/paths.js';
import { BlockedError } from '../src/lib/errors.js';
import { cleanupTmp, setupContainer, setConfig, writeHook } from './helpers.js';

afterEach(cleanupTmp);

const BIN = fileURLToPath(new URL('../bin/laines.js', import.meta.url));
const fromHook = (deps, event = 'post-create') => ({ ...deps, env: { ...deps.env, LAINES_HOOK: event } });
const audit = (s) => {
  const file = join(s.container, '.laines', 'audit.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

async function keptLane() {
  const s = await setupContainer();
  await invoke('create', { container: s.container }, s.deps);
  await invoke('keep', { lane: 'lane_1', reason: 'mine', container: s.container }, s.deps);
  return s;
}

describe('human-only commands run from a hook', () => {
  it('refuses teardown and release by default, naming the event and how a human enables them', async () => {
    const s = await keptLane();
    const hook = fromHook(s.deps);
    for (const [name, opts] of [['release', { lane: 'lane_1' }], ['teardown', { lane: 'lane_2', dryRun: true }]]) {
      const err = await invoke(name, { ...opts, container: s.container }, hook).catch((e) => e);
      expect(err, name).toBeInstanceOf(BlockedError);
      expect(err.exitCode, name).toBe(3);
      expect(err.message, name).toContain('post-create');
      expect(err.message, name).toContain(`laines ${name}`);
      expect(err.message, name).toContain('laines config set hooks.manage true');
    }
    expect(readLanes({ paths: containerPaths(s.container) }).lanes.lane_1.kept).toBeTruthy();
    expect(audit(s).filter((e) => e.action === 'hook-refused').map((e) => [e.command, e.event])).toEqual([
      ['release', 'post-create'],
      ['teardown', 'post-create'],
    ]);
  });

  it('allows teardown and release once a human sets hooks.manage', async () => {
    const s = await keptLane();
    await invoke('config set', { key: 'hooks.manage', value: 'true', container: s.container }, s.deps);
    const hook = fromHook(s.deps, 'pre-teardown');
    expect(await invoke('release', { lane: 'lane_1', container: s.container }, hook)).toEqual({ lane: 'lane_1', released: true });
    expect(await invoke('teardown', { lane: 'lane_1', dryRun: true, container: s.container }, hook)).toMatchObject({ dryRun: true });
  });

  it('never allows commands that change the gates, nor adopt, even with hooks.manage', async () => {
    const s = await keptLane();
    setConfig(s.container, (c) => { c.hooks.manage = true; });
    const hook = fromHook(s.deps);
    const refused = [
      ['config set', { key: 'hooks.policy', value: 'open' }],
      ['hooks approve', {}],
      ['hooks policy', { policy: 'open' }],
      ['adopt', { dir: s.root }],
    ];
    for (const [name, opts] of refused) {
      const err = await invoke(name, { ...opts, container: s.container }, hook).catch((e) => e);
      expect(err, name).toBeInstanceOf(BlockedError);
      expect(err.message, name).toContain('never');
    }
    expect(JSON.parse(readFileSync(join(s.container, '.laines', 'config.json'), 'utf8')).hooks.policy).toBe('notify');
  });

  it('leaves commands that are not human-only, and calls outside a hook, unchanged', async () => {
    const s = await keptLane();
    const hook = fromHook(s.deps);
    expect(await invoke('report', { lane: 'lane_1', status: 'x', container: s.container }, hook)).toMatchObject({ status: 'x' });
    expect(await invoke('create', { container: s.container }, hook)).toMatchObject({ lane: 'lane_2' });
    expect(await invoke('release', { lane: 'lane_1', container: s.container }, s.deps)).toEqual({ lane: 'lane_1', released: true });
    expect(audit(s).some((e) => e.action === 'hook-refused')).toBe(false);
  });

  it('end to end: a post-create hook calling `laines release` fails, then works with hooks.manage', async () => {
    const s = await keptLane();
    const cmd = `LAINES_CONFIG_DIR='${s.deps.env.LAINES_CONFIG_DIR}' '${process.execPath}' '${BIN}' release lane_1 --container '${s.container}'`;
    writeHook(s.container, 'post-create', cmd);
    const err = await invoke('create', { container: s.container }, s.deps).catch((e) => e);
    expect(err.message).toContain('post-create');
    const state = () => readLanes({ paths: containerPaths(s.container) }).lanes;
    expect(state().lane_1.kept).toBeTruthy();
    expect(state().lane_2.state).toBe('setup-failed');
    await invoke('config set', { key: 'hooks.manage', value: 'true', container: s.container }, s.deps);
    await invoke('refresh', { lane: 'lane_2', container: s.container }, s.deps);
    expect(state().lane_1.kept).toBeNull();
  }, 30000);
});
