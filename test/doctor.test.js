import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.js';
import { runDoctor } from '../src/commands/doctor.js';
import { runCreate } from '../src/commands/create.js';
import { formatDoctor } from '../src/lib/format.js';
import { runDotAi } from '../src/lib/dotai.js';
import { claimContainer, loadIndex } from '../src/lib/machine-index.js';
import { NotAContainerError } from '../src/lib/errors.js';
import { loadContainer } from '../src/lib/container.js';
import { updateLanes } from '../src/lib/lanes-store.js';
import { tmp, cleanupTmp, testDeps, setupContainer, writeHook, setConfig } from './helpers.js';

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
    expect(r.checks.map((x) => x.name)).toEqual(['container-marker', 'config', 'machine-index', 'dot-ai', 'agent-files', 'deny-rules', 'mcp', 'board', 'lock', 'machine-lock', 'lanes-state', 'hooks', 'ai-sync', 'agent-reach', 'elicitation-hooks']);
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

  it('flags a stale machine-index lock', async () => {
    const { deps, c } = await container();
    const lock = join(deps.env.LAINES_CONFIG_DIR, '.lock');
    mkdirSync(lock);
    const r = await runDoctor({ container: c }, deps);
    expect(r.ok).toBe(false);
    expect(byName(r)['machine-lock'].ok).toBe(false);
    expect(byName(r)['machine-lock'].detail).toContain(`rmdir '${lock}'`);
  });

  it('resolves a relative or symlinked --container to the canonical path', async () => {
    const { root, deps, c } = await container();
    const rel = await runDoctor({ container: 'lanes' }, deps);
    expect(rel.container.path).toBe(c);
    symlinkSync(c, join(root, 'link'));
    const linked = await runDoctor({ container: join(root, 'link') }, deps);
    expect(linked.ok).toBe(true);
    expect(linked.container.path).toBe(c);
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

describe('doctor lane checks', () => {
  it('checks each open lane and reports agent reach', async () => {
    const { deps, container } = await setupContainer({ agents: 'claude,codex' });
    await runCreate({ container }, deps);
    const r = await runDoctor({ container }, deps);
    const names = r.checks.map((c) => c.name);
    expect(names).toContain('lane:lane_1');
    expect(r.checks.find((c) => c.name === 'lane:lane_1').ok).toBe(true);
    const reach = r.checks.find((c) => c.name === 'agent-reach');
    expect(reach.ok).toBe(true);
    expect(reach.detail).toContain('claude');
    expect(reach.detail).toContain('codex: 1/1 lane(s) have AGENTS.md');
    expect(r.ok).toBe(true);
  });

  it('flags a broken lane: missing env file, stray dot-ai scaffolding, missing clone', async () => {
    const { deps, container } = await setupContainer();
    const one = await runCreate({ container }, deps);
    const two = await runCreate({ container }, deps);
    rmSync(join(one.path, '.laines.env'));
    mkdirSync(join(one.path, '.ai', 'knowledge'));
    rmSync(two.path, { recursive: true, force: true });
    const r = await runDoctor({ container }, deps);
    const byName = Object.fromEntries(r.checks.map((c) => [c.name, c]));
    expect(r.ok).toBe(false);
    expect(byName['lane:lane_1'].ok).toBe(false);
    expect(byName['lane:lane_1'].detail).toContain('.laines.env missing');
    expect(byName['lane:lane_1'].detail).toContain('dot-ai');
    expect(byName['lane:lane_2'].detail).toContain('clone missing');
  });

  it('flags a lane whose repository tracks .claude/settings.local.json', async () => {
    const { deps, container } = await setupContainer({ files: { 'README.md': 'x\n', '.claude/settings.local.json': '{}\n' } });
    await runCreate({ container }, deps);
    const r = await runDoctor({ container }, deps);
    const lane = r.checks.find((c) => c.name === 'lane:lane_1');
    expect(lane.ok).toBe(false);
    expect(lane.detail).toContain('.claude/settings.local.json is tracked by the repository: lane deny rules cannot be written');
  });

  it('flags a lane whose git exclude block is missing a line', async () => {
    const { deps, container } = await setupContainer();
    const one = await runCreate({ container }, deps);
    await runCreate({ container }, deps);
    const file = join(one.path, '.git', 'info', 'exclude');
    writeFileSync(file, readFileSync(file, 'utf8').split('\n').filter((l) => l !== '/.mcp.json').join('\n'));
    const r = byName(await runDoctor({ container }, deps));
    expect(r['lane:lane_1'].ok).toBe(false);
    expect(r['lane:lane_1'].detail).toContain('git exclude block outdated: run `laines refresh lane_1`');
    expect(r['lane:lane_2'].ok).toBe(true);
  });

  it('flags a lane whose clone is not a git repository', async () => {
    const { deps, container } = await setupContainer();
    const one = await runCreate({ container }, deps);
    rmSync(join(one.path, '.git'), { recursive: true, force: true });
    const r = await runDoctor({ container }, deps);
    const lane = r.checks.find((c) => c.name === 'lane:lane_1');
    expect(lane.ok).toBe(false);
    expect(lane.detail).toContain('not a git repository');
  });

  it('reports hooks, and flags hooks that cannot run or will be refused', async () => {
    const s = await setupContainer();
    expect(byName(await runDoctor({ container: s.container }, s.deps)).hooks).toMatchObject({ ok: true, detail: 'policy notify; no hooks' });
    writeHook(s.container, 'post-create', 'true');
    expect(byName(await runDoctor({ container: s.container }, s.deps)).hooks).toMatchObject({ ok: true, detail: 'policy notify; 1 hook(s): 1 new' });
    writeHook(s.container, 'pre-teardown', 'true', { mode: 0o644 });
    const bad = byName(await runDoctor({ container: s.container }, s.deps)).hooks;
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain('not executable: pre-teardown');
    writeHook(s.container, 'pre-teardown', 'true');
    setConfig(s.container, (c) => { c.hooks.policy = 'approve'; });
    expect(byName(await runDoctor({ container: s.container }, s.deps)).hooks.detail).toContain('policy approve will refuse post-create, pre-teardown');
  });

  it('suggests a lock once the hook set is stable', async () => {
    const s = await setupContainer();
    setConfig(s.container, (c) => { c.hooks.stableAfter = 1; });
    writeHook(s.container, 'post-create', 'true');
    await runCreate({ container: s.container }, s.deps);
    expect(byName(await runDoctor({ container: s.container }, s.deps)).hooks.detail).toContain('laines hooks approve --lock');
  });

  it('flags a setup-failed lane and a create interrupted long ago', async () => {
    const s = await setupContainer();
    writeHook(s.container, 'post-create', 'exit 1');
    await runCreate({ container: s.container }, s.deps).catch(() => {});
    writeHook(s.container, 'post-create', 'true');
    await runCreate({ container: s.container }, s.deps);
    const ctx = loadContainer({ container: s.container }, s.deps);
    const setUpdated = (ts) => updateLanes(ctx, s.deps, (st) => {
      Object.assign(st.lanes.lane_2, { status: 'spinning up', updated: ts });
      return { state: st, result: null };
    });
    await setUpdated('2026-09-29T11:55:00.000Z');
    let r = byName(await runDoctor({ container: s.container }, s.deps));
    expect(r['lane:lane_1'].detail).toContain('setup failed: fix the hook, then run `laines refresh lane_1`');
    expect(r['lane:lane_2'].ok).toBe(true);
    await setUpdated('2026-09-29T10:00:00.000Z');
    r = byName(await runDoctor({ container: s.container }, s.deps));
    expect(r['lane:lane_2'].detail).toContain('create was interrupted');
    expect(r['lane:lane_2'].detail).toContain('laines refresh lane_2');
    expect(r['lane:lane_2'].detail).toContain('laines teardown lane_2 --remove-dir --force');
  });

  it('flags a container or lane whose MCP wiring is missing', async () => {
    const s = await setupContainer();
    const lane = await runCreate({ container: s.container }, s.deps);
    writeFileSync(join(s.container, '.mcp.json'), '{}');
    writeFileSync(join(lane.path, '.mcp.json'), '{}');
    const r = byName(await runDoctor({ container: s.container }, s.deps));
    expect(r.mcp.ok).toBe(false);
    expect(r.mcp.detail).toContain('laines-mcp');
    expect(r['lane:lane_1'].detail).toContain('laines refresh lane_1');
  });

  it('warns when a Claude Elicitation hook could answer teardown confirmations', async () => {
    const s = await setupContainer();
    const settings = join(s.root, 'home', '.claude', 'settings.json');
    mkdirSync(join(s.root, 'home', '.claude'), { recursive: true });
    writeFileSync(settings, JSON.stringify({ hooks: { Elicitation: [{ hooks: [{ type: 'command', command: 'true' }] }] } }));
    const r = await runDoctor({ container: s.container }, s.deps);
    const check = byName(r)['elicitation-hooks'];
    expect(check).toMatchObject({ ok: true, warn: true });
    expect(check.detail).toContain(settings);
    expect(r.ok).toBe(true);
    expect(formatDoctor(r).split('\n').some((l) => l.startsWith('! elicitation-hooks'))).toBe(true);
  });

  it('reports a malformed .mcp.json as malformed, not missing', async () => {
    const s = await setupContainer();
    const lane = await runCreate({ container: s.container }, s.deps);
    writeFileSync(join(s.container, '.mcp.json'), '{ nope');
    writeFileSync(join(lane.path, '.mcp.json'), '{ nope');
    const r = byName(await runDoctor({ container: s.container }, s.deps));
    expect(r.mcp.ok).toBe(false);
    expect(r.mcp.detail).toContain('Malformed file');
    expect(r['lane:lane_1'].detail).toContain('malformed');
    expect(r['lane:lane_1'].detail).not.toContain('missing from');
  });

  it('notes .ai/ drift for a lane whose repository commits .ai/', async () => {
    const s = await setupContainer({ files: { 'README.md': '#\n', '.ai/knowledge/a.md': 'A\n' } });
    await runCreate({ container: s.container }, s.deps);
    writeFileSync(join(s.container, '.ai', 'knowledge', 'new.md'), 'N\n');
    const r = byName(await runDoctor({ container: s.container }, s.deps));
    expect(r['lane:lane_1'].ok).toBe(true);
    expect(r['lane:lane_1'].detail).toMatch(/\.ai\/ differs in \d+ file\(s\): run `laines ai sync lane_1`/);
    expect(r['lane:lane_1'].note).toMatch(/^\.ai\/ differs in \d+ file\(s\): run `laines ai sync lane_1`$/);
    expect(r['ai-sync']).toMatchObject({ ok: true, detail: 'base for 1 lane(s)' });
    writeFileSync(join(s.container, '.laines', 'ai-sync.json'), '{');
    expect(byName(await runDoctor({ container: s.container }, s.deps))['ai-sync'].ok).toBe(false);
  });
});

describe('doctor notes', () => {
  it('formatDoctor renders a note as a bullet under its check', () => {
    const out = formatDoctor({ ok: true, container: null, checks: [{ name: 'lane:lane_1', ok: true, detail: 'ok', note: '.ai/ differs in 2 file(s): run `laines ai sync lane_1`' }] });
    expect(out.split('\n').slice(0, 2)).toEqual(['✓ lane:lane_1 — ok', '  • .ai/ differs in 2 file(s): run `laines ai sync lane_1`']);
  });

  it('a repository tracking AGENTS.md and .ai/README.md has no outdated exclude block', async () => {
    const s = await setupContainer({ files: { 'README.md': '#\n', 'AGENTS.md': 'a\n', '.ai/README.md': 'r\n' } });
    await runCreate({ container: s.container }, s.deps);
    const r = byName(await runDoctor({ container: s.container }, s.deps));
    expect(r['lane:lane_1'].detail).not.toContain('outdated');
    expect(r['lane:lane_1'].ok).toBe(true);
  });
});
