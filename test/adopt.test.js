import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { invoke } from '../src/commands/registry.js';
import { runDotAi } from '../src/lib/dotai.js';
import { loadContainer } from '../src/lib/container.js';
import { readLanes } from '../src/lib/lanes-store.js';
import { readAiBase, walk } from '../src/lib/ai-tree.js';
import { loadIndex } from '../src/lib/machine-index.js';
import { denyRules } from '../src/lib/agent-files.js';
import { BlockedError, InvalidInputError, LainesError } from '../src/lib/errors.js';
import { tmp, cleanupTmp, testDeps, gitIn, makeProject, runCli } from './helpers.js';

afterEach(cleanupTmp);

function put(root, rel, text) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function world(opts = {}) {
  const root = tmp();
  mkdirSync(join(root, 'home'));
  const deps = testDeps(root, { runDotAi, ...opts.deps });
  const project = makeProject(root, opts);
  return { root, deps, ...project, adopt: (o = {}) => invoke('adopt', { dir: project.dir, ...o }, deps) };
}

// Everything a user could lose: the file list (minus .git internals, ignored files included) and
// git's view of tracked and untracked changes. (Not `--ignored`: lane-local files are excluded, so
// they would show up there after adopt.)
const snapshot = (dir) => ({
  files: walk(dir).files.filter((f) => !f.startsWith('.git/')),
  status: gitIn(dir, 'status', '--porcelain'),
  stash: gitIn(dir, 'stash', 'list'),
});

describe('adopt refuses', () => {
  it('a folder that is not a git repository, with the setup steps', async () => {
    const w = world();
    const plain = join(w.root, 'plain');
    mkdirSync(plain);
    const err = await invoke('adopt', { dir: plain }, w.deps).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidInputError);
    expect(err.message).toContain('git init -b main');
  });

  it('a worktree, a nested repository, an existing container, a missing or unreachable or empty origin, an operation in progress', async () => {
    const w = world();
    gitIn(w.dir, 'worktree', 'add', '-q', '-b', 'wt', join(w.root, 'wt'));
    const cases = [];
    cases.push(['worktree', join(w.root, 'wt')]);
    const nested = join(w.dir, 'sub');
    gitIn(w.dir, 'init', '-q', nested);
    cases.push(['nested', nested]);
    for (const [why, dir] of cases) await expect(invoke('adopt', { dir }, w.deps), why).rejects.toMatchObject({ exitCode: 2 });

    const c = world();
    gitIn(c.dir, 'remote', 'remove', 'origin');
    await expect(c.adopt()).rejects.toThrow(/origin/);
    gitIn(c.dir, 'remote', 'add', 'origin', join(c.root, 'missing.git'));
    await expect(c.adopt()).rejects.toThrow(/Cannot reach origin/);
    const empty = join(c.root, 'empty.git');
    gitIn(c.root, 'init', '-q', '--bare', empty);
    gitIn(c.dir, 'remote', 'set-url', 'origin', empty);
    await expect(c.adopt()).rejects.toThrow(/no branches yet/);

    const m = world();
    writeFileSync(join(m.dir, '.git', 'MERGE_HEAD'), 'x\n');
    await expect(m.adopt()).rejects.toMatchObject({ exitCode: 2 });

    const a = world();
    await a.adopt();
    await expect(invoke('adopt', { dir: join(a.dir) }, a.deps)).rejects.toMatchObject({ exitCode: 2 });
  });

  it('an interrupted earlier adopt, with the command that puts it back', async () => {
    const w = world();
    renameSync(w.dir, join(dirname(w.dir), '.myapp.laines-adopt-2026-10-02T12-00-00-000Z'));
    const err = await w.adopt().catch((e) => e);
    expect(err).toBeInstanceOf(BlockedError);
    expect(err.message).toContain('mv ');
  });

  it('an interrupted earlier adopt reached through a symlink to the project', async () => {
    const w = world();
    const link = join(w.root, 'link');
    symlinkSync(w.dir, link);
    renameSync(w.dir, join(dirname(w.dir), '.myapp.laines-adopt-2026-10-02T12-00-00-000Z'));
    mkdirSync(w.dir);
    const err = await invoke('adopt', { dir: link }, w.deps).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedError);
    expect(err.exitCode).toBe(3);
    expect(err.message).toContain('mv ');
  });

  it('a stray .laines/ without a container marker gets the interrupted-adopt hint', async () => {
    const w = world();
    const dir = join(w.root, 'half');
    mkdirSync(join(dir, '.laines'), { recursive: true });
    mkdirSync(join(dir, 'lane_1', '.git'), { recursive: true });
    const err = await invoke('adopt', { dir }, w.deps).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidInputError);
    expect(err.message).toContain(`the project may be in ${join(dir, 'lane_1')}`);
  });

  it('a project whose .ai is a symbolic link', async () => {
    const w = world();
    mkdirSync(join(w.root, 'elsewhere'));
    symlinkSync(join(w.root, 'elsewhere'), join(w.dir, '.ai'));
    const before = snapshot(w.dir);
    const err = await w.adopt().catch((e) => e);
    expect(err).toBeInstanceOf(InvalidInputError);
    expect(err.exitCode).toBe(2);
    expect(err.message).toContain('.ai is a symbolic link');
    expect(snapshot(w.dir)).toEqual(before);
  });
});

describe('adopt', () => {
  it('turns the folder into a container whose lane_1 is the original checkout, losing nothing', async () => {
    const w = world({ files: { 'README.md': '# app\n', '.gitignore': 'node_modules/\n' } });
    put(w.dir, 'README.md', '# changed\n');
    put(w.dir, 'notes.txt', 'untracked\n');
    put(w.dir, 'node_modules/x/index.js', 'ignored\n');
    put(w.dir, 'stashed.txt', 's\n');
    gitIn(w.dir, 'add', 'stashed.txt');
    gitIn(w.dir, 'stash', 'push', '-q', '-m', 'mine');
    const before = snapshot(w.dir);
    const r = await w.adopt();
    const laneDir = join(w.dir, 'lane_1');
    expect(r).toMatchObject({ dryRun: false, path: w.dir, lane: 'lane_1', lanePath: laneDir, branch: 'main', ai: { mode: 'fresh' } });
    expect(snapshot(laneDir).stash).toBe(before.stash);
    expect(snapshot(laneDir).status).toBe(before.status);
    for (const f of before.files) expect(existsSync(join(laneDir, f)), f).toBe(true);
    const ctx = loadContainer({ container: w.dir }, w.deps);
    expect(readLanes(ctx).lanes.lane_1).toMatchObject({ number: 1, state: 'active', status: 'idle', ports: r.ports });
    expect(readFileSync(join(ctx.paths.audit), 'utf8')).toContain('"action":"adopt"');
    expect(readdirSync(dirname(w.dir)).filter((e) => e.includes('laines-adopt'))).toEqual([]);
    const doctor = await invoke('doctor', { container: w.dir }, w.deps);
    expect(doctor.checks.filter((c) => !c.ok)).toEqual([]);
    const two = await invoke('create', { container: w.dir }, w.deps);
    expect(two).toMatchObject({ lane: 'lane_2', number: 2 });
    expect(gitIn(two.path, 'status', '--porcelain')).toBe('');
  });

  it("makes the project's .ai/ the container's shared layer", async () => {
    const w = world({ files: { 'README.md': '#\n', '.ai/knowledge/a.md': 'A\n' } });
    put(w.dir, '.ai/notes/local.md', 'N\n');
    put(w.dir, '.ai/guidelines/style.md', 'G\n');
    put(w.dir, '.ai/context/handoff.md', 'H\n');
    const r = await w.adopt();
    const laneDir = join(w.dir, 'lane_1');
    expect(r.ai).toEqual({ mode: 'seed', files: 4 });
    for (const rel of ['knowledge/a.md', 'notes/local.md', 'guidelines/style.md', 'context/handoff.md']) expect(existsSync(join(w.dir, '.ai', rel)), rel).toBe(true);
    expect(existsSync(join(laneDir, '.ai', 'knowledge', 'a.md'))).toBe(true);
    expect(existsSync(join(laneDir, '.ai', 'notes'))).toBe(false);
    expect(existsSync(join(laneDir, '.ai', 'guidelines'))).toBe(false);
    const doctor = await invoke('doctor', { container: w.dir }, w.deps);
    expect(doctor.checks.find((c) => c.name === 'lane:lane_1').ok).toBe(true);
    expect(existsSync(join(laneDir, '.ai', 'context', 'handoff.md'))).toBe(false);
    expect(existsSync(join(laneDir, '.ai', 'context', 'README.md'))).toBe(true);
    expect(Object.keys(readAiBase(loadContainer({ container: w.dir }, w.deps).paths))).toEqual(['knowledge/a.md']);
    expect(gitIn(laneDir, 'status', '--porcelain')).toBe('');
  });

  it('never removes an untracked .ai/ file from the lane when laines wrote its own version in the container', async () => {
    const w = world({ files: { 'README.md': '#\n' } });
    put(w.dir, '.ai/runbooks/lane-management.md', 'my own runbook\n');
    put(w.dir, '.ai/notes/idea.md', 'I\n');
    const r = await w.adopt();
    const laneDir = join(w.dir, 'lane_1');
    expect(readFileSync(join(laneDir, '.ai', 'runbooks', 'lane-management.md'), 'utf8')).toBe('my own runbook\n');
    expect(existsSync(join(laneDir, '.ai', 'notes'))).toBe(false);
    expect(r.warnings.join('\n')).toMatch(/kept in lane_1\/\.ai\/.*runbooks\/lane-management\.md/);
  });

  it('moves an untracked dot-ai scaffold into the container, keeping the lines laines appends to', async () => {
    const w = world({ files: { 'README.md': '#\n' } });
    put(w.dir, '.ai/README.md', '# my .ai\n');
    put(w.dir, '.ai/context/README.md', '# Context\n\nuser context line\n');
    put(w.dir, '.ai/runbooks/README.md', '# Runbooks\n\n## Index\n\n| File | Answers |\n|---|---|\n| [mine.md](mine.md) | user runbook line |\n');
    put(w.dir, '.ai/runbooks/mine.md', 'M\n');
    put(w.dir, '.ai/plans/README.md', '# my plans\n');
    const r = await w.adopt();
    const laneDir = join(w.dir, 'lane_1');
    expect(r.warnings.join('\n')).not.toContain('kept');
    const shared = (rel) => readFileSync(join(w.dir, '.ai', rel), 'utf8');
    expect(shared('context/README.md')).toContain('user context line');
    expect(shared('runbooks/README.md')).toContain('user runbook line');
    expect(shared('runbooks/README.md')).toContain('lane-management.md');
    expect(shared('README.md')).toBe('# my .ai\n');
    expect(shared('plans/README.md')).toBe('# my plans\n');
    expect(existsSync(join(laneDir, '.ai', 'runbooks'))).toBe(false);
    expect(gitIn(laneDir, 'status', '--porcelain')).toBe('');
  });

  it('skips unreadable folders when looking for virtualenvs', async () => {
    const w = world();
    put(w.dir, 'locked/inner/x.txt', 'x\n');
    chmodSync(join(w.dir, 'locked'), 0o000);
    try {
      expect((await w.adopt()).lane).toBe('lane_1');
    } finally {
      chmodSync(join(w.dir, 'lane_1', 'locked'), 0o755);
    }
  });

  it('keeps untracked lane-local files as .pre-laines backups, hidden from git, only for files laines writes', async () => {
    const w = world();
    put(w.dir, 'CLAUDE.local.md', 'my own notes\n');
    put(w.dir, 'AGENTS.md', 'codex is not configured\n');
    const r = await w.adopt();
    expect(r.backups).toEqual([{ from: 'CLAUDE.local.md', to: 'CLAUDE.local.md.pre-laines' }]);
    expect(readFileSync(join(w.dir, 'lane_1', 'CLAUDE.local.md.pre-laines'), 'utf8')).toBe('my own notes\n');
    expect(readFileSync(join(w.dir, 'lane_1', 'CLAUDE.local.md'), 'utf8')).toContain('lane_1');
    expect(readFileSync(join(w.dir, 'lane_1', 'AGENTS.md'), 'utf8')).toBe('codex is not configured\n');
    expect(gitIn(join(w.dir, 'lane_1'), 'status', '--porcelain')).not.toContain('pre-laines');
  });

  it('warns about virtualenvs, unpushed commits and .ai/ symlinks', async () => {
    const w = world();
    put(w.dir, 'api/.venv/pyvenv.cfg', 'home = /usr/bin\n');
    put(w.dir, 'local.txt', 'x\n');
    gitIn(w.dir, 'add', 'local.txt');
    gitIn(w.dir, 'commit', '-q', '-m', 'local only');
    mkdirSync(join(w.dir, '.ai'));
    symlinkSync(join(w.root, 'home'), join(w.dir, '.ai', 'linked'));
    const r = await w.adopt();
    const text = r.warnings.join('\n');
    expect(text).toContain('api/.venv');
    expect(text).toContain('1 commit(s) exist on no remote');
    expect(text).toContain('linked');
  });

  it('records the default branch on a detached HEAD', async () => {
    const w = world();
    gitIn(w.dir, 'checkout', '-q', '--detach');
    expect((await w.adopt()).branch).toBe('main');
  });

  it('follows a symlink to the project and quotes paths with spaces', async () => {
    const w = world({ path: 'My Projects/key stone' });
    const link = join(w.root, 'link');
    symlinkSync(w.dir, link);
    const r = await invoke('adopt', { dir: link }, w.deps);
    expect(r.path).toBe(w.dir);
    expect(r.next[0]).toBe(`cd '${join(w.dir, 'lane_1')}'`);
  });

  it('dry run changes nothing', async () => {
    const w = world();
    put(w.dir, 'CLAUDE.local.md', 'mine\n');
    const before = snapshot(w.dir);
    const index = JSON.stringify(loadIndex(w.deps.env.LAINES_CONFIG_DIR));
    const r = await w.adopt({ dryRun: true });
    expect(r).toMatchObject({ dryRun: true, lane: 'lane_1', backups: [{ from: 'CLAUDE.local.md', to: 'CLAUDE.local.md.pre-laines' }] });
    expect(snapshot(w.dir)).toEqual(before);
    expect(JSON.stringify(loadIndex(w.deps.env.LAINES_CONFIG_DIR))).toBe(index);
  });
});

describe('adopt rollback', () => {
  it('restores the original folder exactly when container setup fails', async () => {
    const w = world({ deps: { runDotAi: () => ({ status: 1, stdout: '', stderr: 'dot-ai broke', error: undefined }) } });
    put(w.dir, 'notes.txt', 'n\n');
    const before = snapshot(w.dir);
    const err = await w.adopt().catch((e) => e);
    expect(err).toBeInstanceOf(LainesError);
    expect(err.message).toContain('dot-ai broke');
    expect(err.message).toContain('restored');
    expect(snapshot(w.dir)).toEqual(before);
    expect(loadIndex(w.deps.env.LAINES_CONFIG_DIR).containers).toEqual([]);
    expect(readdirSync(dirname(w.dir)).filter((e) => e.includes('laines-adopt'))).toEqual([]);
  });

  it('leaves anything adopt did not write, says where the project is, and the hint finishes the restore', async () => {
    const w = world({
      deps: {
        runDotAi: (args, o) => {
          writeFileSync(join(o.cwd, 'stranger.txt'), 'not ours\n');
          return { status: 1, stdout: '', stderr: 'dot-ai broke', error: undefined };
        },
      },
    });
    const before = snapshot(w.dir);
    const laneDir = join(w.dir, 'lane_1');
    const err = await w.adopt().catch((e) => e);
    expect(err.message).toContain('stranger.txt');
    expect(err.message).toContain(`the project is in ${laneDir}`);
    expect(readFileSync(join(w.dir, 'stranger.txt'), 'utf8')).toBe('not ours\n');
    expect(existsSync(join(laneDir, '.git'))).toBe(true);
    unlinkSync(join(w.dir, 'stranger.txt'));
    const hint = err.message.split('\n').map((l) => l.trim()).find((l) => l.startsWith('mv '));
    execFileSync('sh', ['-c', hint]);
    expect(snapshot(w.dir)).toEqual(before);
  });

  it('restores the original folder when registering the lane fails', async () => {
    const w = world({
      deps: {
        runDotAi: (args, o) => {
          const r = runDotAi(args, o);
          mkdirSync(join(o.cwd, '.laines', '.lock'), { recursive: true }); // the lane registration lock will time out
          return r;
        },
      },
    });
    const before = snapshot(w.dir);
    await expect(w.adopt()).rejects.toThrow(/Could not acquire the lock/);
    expect(snapshot(w.dir)).toEqual(before);
  });

  it('keeps the container when a lane file fails after registration, and says to refresh', async () => {
    const w = world();
    const git = (args, o) => (args.includes('info/exclude') ? { status: 1, stdout: '', stderr: 'exclude broke', error: undefined } : w.deps.git(args, o));
    const err = await invoke('adopt', { dir: w.dir }, { ...w.deps, git }).catch((e) => e);
    expect(err.message).toContain('laines refresh lane_1');
    expect(existsSync(join(w.dir, '.laines', 'container.json'))).toBe(true);
    expect(existsSync(join(w.dir, 'lane_1', '.git'))).toBe(true);
  });
});

describe('adopt wiring', () => {
  it('is human-only: CLI only, with deny rules, and refresh adds the rules to older containers', async () => {
    expect(denyRules()).toContain('Bash(laines adopt:*)');
    const w = world();
    const r = await runCli(['adopt', w.dir, '--format', 'table'], w.deps);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`adopted ${w.dir}`);
    const settings = join(w.dir, '.claude', 'settings.json');
    const data = JSON.parse(readFileSync(settings, 'utf8'));
    data.permissions.deny = data.permissions.deny.filter((x) => !x.includes('adopt'));
    writeFileSync(settings, JSON.stringify(data));
    await invoke('refresh', { lane: 'lane_1', container: w.dir }, w.deps);
    expect(JSON.parse(readFileSync(settings, 'utf8')).permissions.deny).toContain('Bash(laines adopt:*)');
  });
});
