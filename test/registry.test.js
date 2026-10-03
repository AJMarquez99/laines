import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildProgram } from '../src/cli.js';
import { COMMANDS, invoke } from '../src/commands/registry.js';
import { HUMAN_ONLY_COMMANDS } from '../src/lib/agent-files.js';
import { BlockedError, CapabilityDeniedError } from '../src/lib/errors.js';
import { cleanupTmp, setupContainer, setConfig, runCli } from './helpers.js';

afterEach(cleanupTmp);

const leaves = (cmd, prefix = []) =>
  cmd.commands.flatMap((c) => (c.commands.length ? leaves(c, [...prefix, c.name()]) : [[...prefix, c.name()].join(' ')]));

describe('command registry', () => {
  it('has an entry, with a capability decision, for every CLI command', () => {
    expect(leaves(buildProgram()).filter((n) => n !== 'help').sort()).toEqual(Object.keys(COMMANDS).sort());
    for (const [name, entry] of Object.entries(COMMANDS)) {
      expect(typeof entry.run, name).toBe('function');
      expect(entry.capability === null || ['create', 'report', 'keep', 'teardown'].includes(entry.capability), name).toBe(true);
    }
  });

  it('marks exactly the commands that carry agent deny rules as human-only', () => {
    const humanOnly = Object.entries(COMMANDS).filter(([, e]) => e.humanOnly).map(([n]) => n).sort();
    expect(humanOnly).toEqual([...HUMAN_ONLY_COMMANDS].sort());
  });

  it('refuses a command whose capability is off with exit 4, from the CLI too', async () => {
    const s = await setupContainer();
    setConfig(s.container, (c) => { c.capabilities.create = false; });
    const err = await invoke('create', { container: s.container }, s.deps).catch((e) => e);
    expect(err).toBeInstanceOf(CapabilityDeniedError);
    expect(err.exitCode).toBe(4);
    expect(err.message).toContain('laines config set capabilities.create true');
    expect((await runCli(['create', '--container', s.container], s.deps)).code).toBe(4);
    expect((await runCli(['refresh', 'lane_1', '--container', s.container], s.deps)).code).toBe(4);
    expect((await runCli(['list', '--container', s.container], s.deps)).code).toBe(0);
  });

  it('refuses human-only changes in a locked container, dry runs included, with exit 3', async () => {
    const s = await setupContainer();
    await invoke('create', { container: s.container }, s.deps);
    setConfig(s.container, (c) => { c.locked = true; });
    const c = s.container;
    const refused = [
      ['release', { lane: 'lane_1' }],
      ['hooks approve', { dryRun: true }],
      ['hooks policy', { policy: 'open' }],
      ['config set', { key: 'hooks.timeoutSec', value: '60', dryRun: true }],
      ['teardown', { lane: 'lane_1', removeDir: true, force: true }],
    ];
    for (const [name, opts] of refused) {
      const err = await invoke(name, { ...opts, container: c }, s.deps).catch((e) => e);
      expect(err, name).toBeInstanceOf(BlockedError);
      expect(err.message, name).toContain('locked');
    }
    expect((await runCli(['hooks', 'policy', 'open', '--container', c], s.deps)).code).toBe(3);
    expect(await invoke('teardown', { lane: 'lane_1', dryRun: true, container: c }, s.deps)).toMatchObject({ dryRun: true });
    expect(await invoke('report', { lane: 'lane_1', status: 'x', container: c }, s.deps)).toMatchObject({ status: 'x' });
  });
});

describe('config set', () => {
  const file = (s) => join(s.container, '.laines', 'config.json');

  it('changes one key in the file as written, validates it, logs it and audits it', async () => {
    const s = await setupContainer();
    setConfig(s.container, (c) => { delete c.locked; });
    const r = await invoke('config set', { key: 'hooks.timeoutSec', value: '60', container: s.container }, s.deps);
    expect(r).toEqual({ dryRun: false, key: 'hooks.timeoutSec', from: 300, to: 60, changed: true });
    const raw = JSON.parse(readFileSync(file(s), 'utf8'));
    expect(raw.hooks.timeoutSec).toBe(60);
    expect(Object.hasOwn(raw, 'locked')).toBe(false);
    expect(readFileSync(join(s.container, '.laines', 'audit.jsonl'), 'utf8')).toContain('"action":"config-set"');
    expect(readFileSync(join(s.container, '.ai', 'context', 'LANES_BOARD.md'), 'utf8')).toContain('config set hooks.timeoutSec: 300 → 60');
  });

  it('parses JSON values and falls back to strings', async () => {
    const s = await setupContainer();
    await invoke('config set', { key: 'teardown.mcp', value: 'auto', container: s.container }, s.deps);
    await invoke('config set', { key: 'agents', value: '["claude","codex"]', container: s.container }, s.deps);
    const raw = JSON.parse(readFileSync(file(s), 'utf8'));
    expect(raw.teardown.mcp).toBe('auto');
    expect(raw.agents).toEqual(['claude', 'codex']);
  });

  it('rejects unknown keys, invalid values and prototype keys with exit 2, writing nothing', async () => {
    const s = await setupContainer();
    const before = readFileSync(file(s), 'utf8');
    for (const [key, value] of [['hooks.nope', '1'], ['maxLanes', '0'], ['teardown.mcp', 'sometimes'], ['lanePrefix', `l${'a'.repeat(28)}`], ['__proto__.x', '1'], ['hooks.constructor', '1'], ['', '1']]) {
      const err = await invoke('config set', { key, value, container: s.container }, s.deps).catch((e) => e);
      expect(err.exitCode, key).toBe(2);
    }
    expect(readFileSync(file(s), 'utf8')).toBe(before);
    expect({}.x).toBeUndefined();
  });

  it('dry run and unchanged values write nothing', async () => {
    const s = await setupContainer();
    const before = readFileSync(file(s), 'utf8');
    expect(await invoke('config set', { key: 'maxLanes', value: '30', dryRun: true, container: s.container }, s.deps)).toEqual({ dryRun: true, key: 'maxLanes', from: 20, to: 30, changed: true });
    expect(await invoke('config set', { key: 'maxLanes', value: '20', container: s.container }, s.deps)).toMatchObject({ changed: false });
    expect(readFileSync(file(s), 'utf8')).toBe(before);
  });

  it('wires into the CLI as a human-only leaf', async () => {
    const s = await setupContainer();
    const r = await runCli(['config', 'set', 'board.logLimit', '50', '--container', s.container, '--format', 'table'], s.deps);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('board.logLimit: 200 → 50');
    expect((await runCli(['config', '--format', 'json', 'set', 'board.logLimit', '60', '--container', s.container], s.deps)).code).toBe(2);
  });
});
