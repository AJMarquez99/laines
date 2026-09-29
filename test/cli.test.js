import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { runDotAi } from '../src/lib/dotai.js';
import { tmp, cleanupTmp, testDeps } from './helpers.js';

const REMOTE = 'git@example.com:org/my-app.git';

async function cli(args, deps) {
  const out = [];
  const err = [];
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((s) => (err.push(String(s)), true));
  process.exitCode = undefined;
  try {
    await run(['node', 'laines', ...args], deps);
    return { code: process.exitCode ?? 0, stdout: out.join(''), stderr: err.join('') };
  } finally {
    o.mockRestore();
    e.mockRestore();
    process.exitCode = undefined;
  }
}

afterEach(cleanupTmp);

function setup() {
  const root = tmp();
  mkdirSync(join(root, 'home'));
  return { root, deps: testDeps(root, { runDotAi }) };
}

describe('cli', () => {
  it('init prints JSON by default and a table on request', async () => {
    const { deps } = setup();
    const r = await cli(['init', 'lanes', '--remote', REMOTE], deps);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).id).toBe('my-app');
    const t = await cli(['--format', 'table', 'init', 'more', '--remote', REMOTE, '--dry-run'], deps);
    expect(t.code).toBe(0);
    expect(t.stdout).toContain('dry run');
    expect(t.stdout).toContain('my-app-2');
  });

  it('config get reads the whole config or one key, from --container or cwd', async () => {
    const { root, deps } = setup();
    await cli(['init', 'lanes', '--remote', REMOTE], deps);
    const whole = await cli(['--container', join(root, 'lanes'), 'config', 'get'], deps);
    expect(JSON.parse(whole.stdout).maxLanes).toBe(20);
    const inCwd = { ...deps, cwd: () => join(root, 'lanes') };
    const one = await cli(['config', 'get', 'hooks.policy'], inCwd);
    expect(JSON.parse(one.stdout)).toEqual({ key: 'hooks.policy', value: 'notify' });
    const bad = await cli(['config', 'get', 'nope.key'], inCwd);
    expect(bad.code).toBe(2);
  });

  it('maps typed errors and usage errors to exit codes', async () => {
    const { deps } = setup();
    const notContainer = await cli(['config', 'get'], deps);
    expect(notContainer.code).toBe(2);
    expect(notContainer.stderr).toContain('Not a L.AI.nes container');
    const missingRemote = await cli(['init', 'x'], deps);
    expect(missingRemote.code).toBe(2);
    const badFormat = await cli(['--format', 'xml', 'config', 'get'], deps);
    expect(badFormat.code).toBe(2);
    const help = await cli(['--help'], deps);
    expect(help.code).toBe(0);
  });
});
