import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.js';
import { runDoctor } from '../src/commands/doctor.js';
import { runCreate } from '../src/commands/create.js';
import { changedSinceClose } from '../src/lib/lane-git.js';
import { runTeardown } from '../src/commands/teardown.js';
import { runRefresh } from '../src/commands/refresh.js';
import { spawnSync, execFileSync } from 'node:child_process';
import { formatDoctor } from '../src/lib/format.js';
import { runDotAi } from '../src/lib/dotai.js';
import { claimContainer, loadIndex } from '../src/lib/machine-index.js';
import { NotAContainerError } from '../src/lib/errors.js';
import { loadContainer } from '../src/lib/container.js';
import { invoke } from '../src/commands/registry.js';
import { updateLanes } from '../src/lib/lanes-store.js';
import { tmp, cleanupTmp, testDeps, setupContainer, writeHook, setConfig, gitIn } from './helpers.js';

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

  it('adds an mcp-server check only inside the MCP server', async () => {
    const { deps, c } = await container();
    expect(byName(await runDoctor({ container: c }, deps))['mcp-server']).toBeUndefined();
    const stale = await runDoctor({ container: c }, { ...deps, mcpServer: { running: '1.0.0', installed: () => '1.1.0' } });
    expect(byName(stale)['mcp-server']).toMatchObject({ ok: false });
    expect(stale.ok).toBe(false);
    const same = await runDoctor({ container: c }, { ...deps, mcpServer: { running: '1.0.0', installed: () => '1.0.0' } });
    expect(byName(same)['mcp-server']).toMatchObject({ ok: true });
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
    expect(byName(await runDoctor({ container: s.container }, s.deps)).hooks).toMatchObject({ ok: true, warn: true, detail: expect.stringMatching(/^policy notify; 1 hook\(s\): 1 new; /) });
    writeHook(s.container, 'pre-teardown', 'true', { mode: 0o644 });
    const bad = byName(await runDoctor({ container: s.container }, s.deps)).hooks;
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain('not executable: pre-teardown');
    writeHook(s.container, 'pre-teardown', 'true');
    setConfig(s.container, (c) => { c.hooks.policy = 'approve'; });
    expect(byName(await runDoctor({ container: s.container }, s.deps)).hooks.detail).toContain('policy approve will refuse post-create, pre-teardown');
  });

  it('warns, without failing, that new or changed hooks will run unapproved under notify or open', async () => {
    const s = await setupContainer();
    writeHook(s.container, 'post-create', 'true');
    writeHook(s.container, 'pre-teardown', 'true');
    await invoke('hooks approve', { container: s.container }, s.deps);
    writeHook(s.container, 'pre-teardown', 'echo changed');
    writeHook(s.container, 'post-teardown', 'true');
    const r = await runDoctor({ container: s.container }, s.deps);
    const hooks = byName(r).hooks;
    expect(r.ok).toBe(true);
    expect(hooks).toMatchObject({ ok: true, warn: true });
    expect(hooks.note).toBe('pre-teardown (changed), post-teardown (new) will run unapproved at their next event: review with `laines hooks status`, then `laines hooks approve`');
    expect(formatDoctor(r).split('\n').some((l) => l.startsWith('! hooks'))).toBe(true);
    setConfig(s.container, (c) => { c.hooks.policy = 'open'; });
    expect(byName(await runDoctor({ container: s.container }, s.deps)).hooks).toMatchObject({
      ok: true,
      warn: true,
      note: 'pre-teardown (changed), post-teardown (new) run without approval by policy open: review with `laines hooks status`',
    });
    await invoke('hooks approve', { container: s.container }, s.deps);
    expect(byName(await runDoctor({ container: s.container }, s.deps)).hooks).not.toHaveProperty('warn');
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
    expect(r['lane:lane_2'].detail).toContain('laines teardown lane_2 --force');
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

  it('a repository tracking .ai/plans/ and one tracking nothing under .ai/ both pass the exclude check', async () => {
    for (const files of [{ 'README.md': '#\n', '.ai/plans/a.md': 'p\n' }, { 'README.md': '#\n' }]) {
      const s = await setupContainer({ files });
      await runCreate({ container: s.container }, s.deps);
      const r = byName(await runDoctor({ container: s.container }, s.deps));
      expect(r['lane:lane_1'].detail).not.toContain('outdated');
      expect(r['lane:lane_1'].ok).toBe(true);
    }
  });

  describe('exclude block follows what the repository commits', () => {
    const ignored = (dir, rel) => spawnSync('git', ['check-ignore', '-q', rel], { cwd: dir }).status === 0;
    const OLD = ['/.ai/.lane.json', '/.ai/README.md', '/.ai/context/', '/.ai/plans/', '/.laines.env', '/CLAUDE.local.md',
      '/AGENTS.md', '/GEMINI.md', '/.claude/settings.local.json', '/.mcp.json', '/*.pre-laines*'];
    const setBlock = (dir, entries) => {
      const file = join(dir, '.git', 'info', 'exclude');
      const cur = readFileSync(file, 'utf8');
      const b = cur.indexOf('# BEGIN laines lane');
      const eEnd = cur.indexOf('# END laines lane') + '# END laines lane'.length;
      writeFileSync(file, `${cur.slice(0, b)}# BEGIN laines lane (lane-local files, never committed)\n${entries.join('\n')}\n# END laines lane${cur.slice(eEnd)}`);
    };
    const detail = async (s) => byName(await runDoctor({ container: s.container }, s.deps))['lane:lane_1'];

    it('a pre-M4.7 block in a repo tracking plans is flagged; refresh fixes it', async () => {
      const s = await setupContainer({ files: { 'README.md': '#\n', '.ai/plans/README.md': 'r\n', '.ai/plans/a.md': 'p\n' } });
      const lane = await runCreate({ container: s.container }, s.deps);
      setBlock(lane.path, OLD);
      writeFileSync(join(lane.path, '.ai', 'plans', 'new.md'), 'n\n');
      expect(ignored(lane.path, '.ai/plans/new.md')).toBe(true);
      const r = await detail(s);
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('git exclude block outdated: run `laines refresh lane_1`');
      await runRefresh({ container: s.container, lane: 'lane_1' }, s.deps);
      expect(ignored(lane.path, '.ai/plans/new.md')).toBe(false);
      expect((await detail(s)).ok).toBe(true);
    });

    it('a repo that starts, then stops, tracking plans is flagged each time; refresh fixes it', async () => {
      const s = await setupContainer();
      const lane = await runCreate({ container: s.container }, s.deps);
      writeFileSync(join(lane.path, '.ai', 'plans', 'a.md'), 'p\n');
      gitIn(lane.path, 'add', '-f', '.ai/plans/a.md');
      expect((await detail(s)).detail).toContain('outdated');
      await runRefresh({ container: s.container, lane: 'lane_1' }, s.deps);
      expect((await detail(s)).ok).toBe(true);
      gitIn(lane.path, 'rm', '-q', '--cached', '.ai/plans/a.md');
      expect((await detail(s)).detail).toContain('outdated');
      await runRefresh({ container: s.container, lane: 'lane_1' }, s.deps);
      expect((await detail(s)).ok).toBe(true);
    });
  });
});

describe('doctor: closed lanes whose clone remains', () => {
  const CLOSED = '2026-01-01T00:00:00.000Z';
  async function closedLane() {
    const s = await setupContainer();
    const lane = await runCreate({ container: s.container }, s.deps);
    await runTeardown({ lane: 'lane_1', keepDir: true, container: s.container }, s.deps);
    // Pin the close time so the committer dates below are unambiguous.
    await updateLanes(loadContainer({ container: s.container }, s.deps), s.deps, (state) => {
      state.lanes.lane_1.closed = CLOSED;
      return { state, result: null };
    });
    return { s, dir: lane.path };
  }
  const commitAt = (dir, date, ...args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.com', GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
  const OLD = '2025-12-01T00:00:00Z';

  it('notes a clean remaining clone as ok', async () => {
    const { s, dir } = await closedLane();
    // Make every tip older than the close.
    commitAt(dir, OLD, 'commit', '--amend', '--no-edit', '--allow-empty');
    for (const ref of gitIn(dir, 'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags').split('\n').filter(Boolean)) {
      commitAt(dir, OLD, 'update-ref', ref, gitIn(dir, 'rev-parse', 'HEAD').trim());
    }
    const r = await runDoctor({ container: s.container }, s.deps);
    const c = byName(r)['closed:lane_1'];
    expect(c.ok).toBe(true);
    expect(c.note).toBe('closed, but its clone remains: delete it with `laines teardown lane_1`, or ignore');
    expect(formatDoctor(r)).toContain('  • closed, but its clone remains');
  });

  it('fails when a branch was committed after the close', async () => {
    const { s, dir } = await closedLane();
    gitIn(dir, 'checkout', '-q', '-b', 'late-work');
    commitAt(dir, '2026-01-02T00:00:00Z', 'commit', '--allow-empty', '-q', '-m', 'late');
    const r = await runDoctor({ container: s.container }, s.deps);
    const c = byName(r)['closed:lane_1'];
    expect(c.ok).toBe(false);
    expect(r.ok).toBe(false);
    expect(c.detail).toMatch(/closed on 2026-01-01.*refs\/heads\/late-work.*0 uncommitted file\(s\).*belongs to no open lane/);
  });

  it('fails on uncommitted changes', async () => {
    const { s, dir } = await closedLane();
    writeFileSync(join(dir, 'scratch.txt'), 'x\n');
    const c = byName(await runDoctor({ container: s.container }, s.deps))['closed:lane_1'];
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('1 uncommitted file(s)');
  });

  it('adds no check once the clone is gone', async () => {
    const { s, dir } = await closedLane();
    rmSync(dir, { recursive: true, force: true });
    const r = await runDoctor({ container: s.container }, s.deps);
    expect(byName(r)['closed:lane_1']).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  it('only notes a closed lane with no close timestamp', async () => {
    const { s } = await closedLane();
    await updateLanes(loadContainer({ container: s.container }, s.deps), s.deps, (state) => {
      delete state.lanes.lane_1.closed;
      return { state, result: null };
    });
    const c = byName(await runDoctor({ container: s.container }, s.deps))['closed:lane_1'];
    expect(c.ok).toBe(true);
    expect(c.note).toContain('clone remains');
  });

  it('changedSinceClose never throws for a missing or broken clone', async () => {
    const s = await setupContainer();
    expect(changedSinceClose(s.deps, join(s.root, 'nope'), CLOSED)).toEqual({ refs: [], dirty: [] });
    expect(changedSinceClose(s.deps, s.root, 'not a date').refs).toEqual([]);
  });
});
