import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.js';
import { runDoctor } from '../src/commands/doctor.js';
import { runDotAi } from '../src/lib/dotai.js';
import { claimContainer, loadIndex } from '../src/lib/machine-index.js';
import { NotAContainerError } from '../src/lib/errors.js';
import { tmp, cleanupTmp, testDeps } from './helpers.js';

afterEach(cleanupTmp);
const REMOTE = 'git@example.com:org/my-app.git';

async function container() {
  const root = tmp();
  mkdirSync(join(root, 'home'));
  const deps = testDeps(root, { runDotAi });
  await runInit({ dir: 'lanes', remote: REMOTE }, deps);
  return { root, deps, c: join(root, 'lanes') };
}

const byName = (r) => Object.fromEntries(r.checks.map((c) => [c.name, c]));

describe('doctor', () => {
  it('passes every check on a fresh container', async () => {
    const { deps, c } = await container();
    const r = await runDoctor({ container: c }, deps);
    expect(r.ok).toBe(true);
    expect(r.container).toEqual({ id: 'my-app', path: c });
    expect(r.checks.map((x) => x.name)).toEqual(['container-marker', 'config', 'machine-index', 'dot-ai', 'agent-files', 'deny-rules', 'board', 'lock']);
  });

  it('reports each broken piece without throwing', async () => {
    const { deps, c } = await container();
    writeFileSync(join(c, 'CLAUDE.md'), 'wiped\n');
    writeFileSync(join(c, '.claude', 'settings.json'), '{}');
    rmSync(join(c, '.ai', 'context', 'LANES_BOARD.md'));
    mkdirSync(join(c, '.laines', '.lock'));
    writeFileSync(join(c, '.laines', 'config.json'), '{ nope');
    const r = await runDoctor({ container: c }, deps);
    expect(r.ok).toBe(false);
    const n = byName(r);
    for (const name of ['config', 'agent-files', 'deny-rules', 'board', 'lock']) expect(n[name].ok, name).toBe(false);
    expect(n.lock.detail).toContain('rmdir');
    expect(n['container-marker'].ok).toBe(true);
  });

  it('flags a container missing from the machine index', async () => {
    const { deps, c } = await container();
    writeFileSync(join(deps.env.LAINES_CONFIG_DIR, 'containers.json'), JSON.stringify({ version: 1, machine: { range: [20000, 29999], blockSize: 200 }, containers: [] }));
    const r = await runDoctor({ container: c }, deps);
    expect(byName(r)['machine-index'].ok).toBe(false);
  });

  it('prunes deleted containers, from anywhere', async () => {
    const { root, deps } = await container();
    await claimContainer(deps.env.LAINES_CONFIG_DIR, { path: join(root, 'deleted'), baseId: 'old', now: 'x' });
    const r = await runDoctor({ container: root, prune: true }, deps);
    expect(r.container).toBeNull();
    expect(r.pruned).toEqual([{ id: 'old', path: join(root, 'deleted') }]);
    expect(loadIndex(deps.env.LAINES_CONFIG_DIR).containers.map((e) => e.id)).toEqual(['my-app']);
  });

  it('refuses outside a container without --prune', async () => {
    const { root, deps } = await container();
    await expect(runDoctor({ container: root }, deps)).rejects.toBeInstanceOf(NotAContainerError);
  });
});
