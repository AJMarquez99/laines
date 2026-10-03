import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { runGit, runGitAsync, gitOut } from '../src/lib/git.js';
import { busyPorts } from '../src/lib/netports.js';
import { GitError } from '../src/lib/errors.js';
import { tmp, cleanupTmp, testDeps, gitIn, makeRemote } from './helpers.js';

afterEach(cleanupTmp);

describe('runGit', () => {
  it('returns status and output without throwing', () => {
    expect(runGit(['--version']).status).toBe(0);
    expect(runGit(['--version']).stdout).toMatch(/^git version/);
    const bad = runGit(['definitely-not-a-git-command']);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr.length).toBeGreaterThan(0);
  });

  it('runs tests without user or system git config', () => {
    expect(process.env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(process.env.GIT_CONFIG_NOSYSTEM).toBe('1');
  });

  it('ignores GIT_DIR and friends from the environment', () => {
    const repo = tmp();
    gitIn(repo, 'init', '-q');
    const saved = { ...process.env };
    Object.assign(process.env, { GIT_DIR: join(repo, 'nope'), GIT_WORK_TREE: join(repo, 'nope'), GIT_INDEX_FILE: join(repo, 'nope'), GIT_NAMESPACE: 'x' });
    try {
      const r = runGit(['rev-parse', '--show-toplevel'], { cwd: repo });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(repo);
    } finally {
      for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_NAMESPACE']) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it('never lets git prompt for credentials', () => {
    const r = runGit(['-c', 'alias.promptcheck=!printenv GIT_TERMINAL_PROMPT', 'promptcheck'], { cwd: tmp() });
    expect(r.stdout.trim()).toBe('0');
  });

  it('gitOut returns stdout or throws GitError with the stderr', () => {
    const deps = testDeps(tmp());
    expect(gitOut(deps, ['--version'], tmp())).toMatch(/^git version/);
    try {
      gitOut(deps, ['rev-parse', 'HEAD'], tmp());
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(GitError);
      expect(e.exitCode).toBe(1);
      expect(e.message).toContain('git rev-parse failed');
    }
  });
});

describe('busyPorts', () => {
  it('reports a port something is listening on, and nothing for a free one', async () => {
    const server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      expect(await busyPorts([port, port])).toEqual([port]);
    } finally {
      await new Promise((r) => server.close(r));
    }
    expect(await busyPorts([port, port])).toEqual([]);
  });
});

describe('fixtures', () => {
  it('makeRemote builds a cloneable bare repo with branches', () => {
    const root = tmp();
    const remote = makeRemote(root, { files: { 'a.txt': 'a\n', 'docs/b.md': 'b\n' }, branches: ['feature'] });
    expect(remote).toBe(join(root, 'my-app.git'));
    gitIn(root, 'clone', '-q', remote, join(root, 'check'));
    expect(gitIn(join(root, 'check'), 'ls-files').split('\n')).toEqual(expect.arrayContaining(['a.txt', 'docs/b.md']));
    expect(gitIn(join(root, 'check'), 'branch', '-r')).toContain('origin/feature');
  });
});

describe('runGitAsync', () => {
  it('resolves with status and output, never prompts, and ignores GIT_DIR', async () => {
    const ok = await runGitAsync(['--version']);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/^git version/);
    const prompt = await runGitAsync(['-c', 'alias.promptcheck=!printenv GIT_TERMINAL_PROMPT', 'promptcheck'], { cwd: tmp() });
    expect(prompt.stdout.trim()).toBe('0');
    process.env.GIT_DIR = '/nonexistent';
    try {
      const r = await runGitAsync(['-c', 'alias.gd=!printenv GIT_DIR || echo unset', 'gd'], { cwd: tmp() });
      expect(r.stdout.trim()).toBe('unset');
    } finally {
      delete process.env.GIT_DIR;
    }
    const bad = await runGitAsync(['definitely-not-a-git-command']);
    expect(bad.status).not.toBe(0);
  });
});
