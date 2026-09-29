import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { runGit, gitOut } from '../src/lib/git.js';
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
