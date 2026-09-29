import { spawnSync } from 'node:child_process';
import { GitError } from './errors.js';

// A lane command must fail, not hang, when a remote needs credentials nobody can type.
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0' };

// These would point git at another repository than cwd, and so aim the deletion guards elsewhere.
const REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_NAMESPACE'];

export function runGit(args, { cwd } = {}) {
  const env = { ...process.env, ...GIT_ENV };
  for (const key of REPO_ENV) delete env[key];
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

export function gitOut(deps, args, cwd) {
  const r = deps.git(args, { cwd });
  if (r.error || r.status !== 0) throw new GitError(args, r);
  return r.stdout;
}
