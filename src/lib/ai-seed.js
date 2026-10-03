import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { copyTree, syncedState } from './ai-tree.js';
import { configDir } from './paths.js';

const lastLine = (s) => String(s ?? '').trim().split('\n').filter(Boolean).pop() ?? 'unknown error';

// Design §4.1: a new container's shared .ai/ starts from the remote's default branch when it commits
// one. Only .ai/ is checked out of a shallow, blob-less clone in a temp dir under the machine config
// dir, which is always removed.
export async function seedFromRemote(deps, remote, branch, destAi) {
  const config = configDir(deps.env, deps.homedir());
  mkdirSync(config, { recursive: true });
  const tmp = mkdtempSync(join(config, 'seed-'));
  const none = { seeded: false, files: 0, base: {}, warning: null };
  const unreadable = (why) => ({ ...none, warning: `could not read the remote's .ai/ (${why}); the container starts with a fresh .ai/ layer` });
  try {
    const repo = join(tmp, 'repo');
    const clone = await deps.gitAsync(
      ['clone', '--quiet', '--depth', '1', '--filter=blob:none', '--no-checkout', '--branch', branch, '--', remote, repo],
      { cwd: tmp },
    );
    if (clone.error || clone.status !== 0) return unreadable(lastLine(clone.stderr || clone.error?.message));
    const listed = deps.git(['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', '.ai'], { cwd: repo });
    if (listed.error || listed.status !== 0) return unreadable(lastLine(listed.stderr));
    if (!listed.stdout) return none;
    const checkout = await deps.gitAsync(['checkout', '--quiet', 'HEAD', '--', '.ai'], { cwd: repo });
    if (checkout.error || checkout.status !== 0 || !existsSync(join(repo, '.ai'))) return unreadable(lastLine(checkout.stderr));
    const { copied } = copyTree(join(repo, '.ai'), destAi);
    return { seeded: true, files: copied.length, base: syncedState(join(repo, '.ai')).files, warning: null };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
