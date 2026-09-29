import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCreate } from '../src/commands/create.js';
import { loadContainer } from '../src/lib/container.js';
import { readLanes } from '../src/lib/lanes-store.js';
import { BlockedError, GitError, InvalidInputError } from '../src/lib/errors.js';
import { cleanupTmp, setupContainer, gitIn, runCli } from './helpers.js';

afterEach(cleanupTmp);

describe('create', () => {
  it('clones an isolated lane, writes its files and registers it on the board', async () => {
    const { deps, container } = await setupContainer();
    const r = await runCreate({ container }, deps);
    const laneDir = join(container, 'lane_1');
    expect(r).toMatchObject({ dryRun: false, lane: 'lane_1', id: 'my-app/lane_1', number: 1, path: laneDir, branch: 'main', ports: [20000, 20009], warnings: [] });
    expect(gitIn(laneDir, 'branch', '--show-current').trim()).toBe('main');
    expect(gitIn(laneDir, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(laneDir, '.laines.env'), 'utf8')).toContain('LANE_SUFFIX="_my_app_l1"');
    const ctx = loadContainer({ container }, deps);
    expect(readLanes(ctx).lanes.lane_1).toMatchObject({ state: 'active', status: 'idle', ports: [20000, 20009] });
    expect(readFileSync(ctx.paths.board, 'utf8')).toContain('<!-- lane:lane_1:start -->');
    expect(readFileSync(ctx.paths.audit, 'utf8')).toContain('"action":"create"');
    expect(r.brief.text).toContain('# Lane brief: lane_1');
    expect(r.next[0]).toBe(`cd ${laneDir} && claude`);
  });

  it('gives each lane its own number and ports, tracks remote branches, and creates new ones', async () => {
    const { deps, container } = await setupContainer({ branches: ['feature'] });
    await runCreate({ container }, deps);
    const two = await runCreate({ container, branch: 'feature' }, deps);
    expect(two).toMatchObject({ lane: 'lane_2', ports: [20010, 20019] });
    expect(gitIn(two.path, 'rev-parse', '--abbrev-ref', '@{u}').trim()).toBe('origin/feature');
    const named = await runCreate({ container, name: 'spike', branch: 'try/new' }, deps);
    expect(named).toMatchObject({ lane: 'spike', number: 3, ports: [20020, 20029] });
    expect(gitIn(named.path, 'branch', '--show-current').trim()).toBe('try/new');
  });

  it('dry run plans without cloning or reserving', async () => {
    const { deps, container } = await setupContainer();
    const r = await runCreate({ container, dryRun: true }, deps);
    expect(r).toMatchObject({ dryRun: true, lane: 'lane_1', ports: [20000, 20009] });
    expect(existsSync(join(container, 'lane_1'))).toBe(false);
    expect(readLanes(loadContainer({ container }, deps)).lanes).toEqual({});
  });

  it('refuses bad names and branches before touching anything', async () => {
    const { deps, container } = await setupContainer();
    mkdirSync(join(container, 'taken'));
    for (const opts of [{ name: 'Bad Name' }, { name: '.ai' }, { branch: '-x' }, { branch: 'bad..ref' }, { name: 'taken' }]) {
      await expect(runCreate({ container, ...opts }, deps), JSON.stringify(opts)).rejects.toBeInstanceOf(InvalidInputError);
    }
    expect(readLanes(loadContainer({ container }, deps)).lanes).toEqual({});
  });

  it('rolls back when ports are busy or the clone fails', async () => {
    const s = await setupContainer();
    const busy = { ...s.deps, busyPorts: async ([a]) => [a] };
    await expect(runCreate({ container: s.container }, busy)).rejects.toThrow(/Ports already in use: 20000/);
    const failingGit = { ...s.deps, git: (args, o) => (args[0] === 'clone' ? { status: 128, stdout: '', stderr: 'fatal: repository not found' } : s.deps.git(args, o)) };
    await expect(runCreate({ container: s.container }, failingGit)).rejects.toBeInstanceOf(GitError);
    const ctx = loadContainer({ container: s.container }, s.deps);
    expect(readLanes(ctx).lanes).toEqual({});
    expect(existsSync(join(s.container, 'lane_1'))).toBe(false);
    expect(readFileSync(ctx.paths.board, 'utf8')).toContain('lane creation failed');
  });

  it('stops at maxLanes and reuses the number of a closed lane', async () => {
    const { deps, container } = await setupContainer();
    const cfgFile = join(container, '.laines', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
    writeFileSync(cfgFile, JSON.stringify({ ...cfg, maxLanes: 1 }));
    await runCreate({ container }, deps);
    await expect(runCreate({ container }, deps)).rejects.toBeInstanceOf(BlockedError);
    const lanesFile = join(container, '.laines', 'lanes.json');
    const state = JSON.parse(readFileSync(lanesFile, 'utf8'));
    state.lanes.lane_1.state = 'closed';
    writeFileSync(lanesFile, JSON.stringify(state));
    await expect(runCreate({ container }, deps)).rejects.toThrow(/already exists/);
    const r = await runCreate({ container, name: 'fresh' }, deps);
    expect(r).toMatchObject({ lane: 'fresh', number: 1, ports: [20000, 20009] });
  });

  it('works in a container whose path has spaces, and two creates at once get different lanes', async () => {
    const { deps, container } = await setupContainer({ dir: 'my lanes' });
    const [a, b] = await Promise.all([runCreate({ container }, deps), runCreate({ container }, deps)]);
    expect(new Set([a.lane, b.lane])).toEqual(new Set(['lane_1', 'lane_2']));
    expect(gitIn(a.path, 'status', '--porcelain')).toBe('');
  });

  it('prints a table with the brief', async () => {
    const { deps, container } = await setupContainer();
    const r = await runCli(['create', '--container', container, '--format', 'table'], deps);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('lane lane_1 created');
    expect(r.stdout).toContain('# Lane brief: lane_1');
  });
});
