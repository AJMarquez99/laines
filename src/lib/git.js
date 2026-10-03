import { spawn, spawnSync } from 'node:child_process';
import { GitError } from './errors.js';

// A lane command must fail, not hang, when a remote needs credentials nobody can type.
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0' };

// These would point git at another repository than cwd, and so aim the deletion guards elsewhere.
const REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_NAMESPACE'];

function gitEnv() {
  const env = { ...process.env, ...GIT_ENV };
  for (const key of REPO_ENV) delete env[key];
  return env;
}

export function runGit(args, { cwd } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv() });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

// For long operations (clone): a long-lived MCP server keeps answering while git runs.
export function runGitAsync(args, { cwd } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv() });
    child.stdout.setEncoding('utf8').on('data', (d) => {
      stdout += d;
    });
    child.stderr.setEncoding('utf8').on('data', (d) => {
      stderr += d;
    });
    child.on('error', (error) => resolve({ status: null, stdout, stderr, error }));
    child.on('close', (status) => resolve({ status, stdout, stderr, error: undefined }));
  });
}

export function gitOut(deps, args, cwd) {
  const r = deps.git(args, { cwd });
  if (r.error || r.status !== 0) throw new GitError(args, r);
  return r.stdout;
}

export async function gitOutAsync(deps, args, cwd) {
  const r = await deps.gitAsync(args, { cwd });
  if (r.error || r.status !== 0) throw new GitError(args, r);
  return r.stdout;
}
