import { lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { copyTree, syncedState } from './ai-tree.js';
import { configDir } from './paths.js';

// The informative line of git's stderr: its trailing lines are often boilerplate ("and the repository exists.").
const reason = (stderr, error) => {
  const lines = String(stderr ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^(ssh|fatal|error|remote):/i.test(l)) ?? lines[0] ?? error?.message ?? 'unknown error';
};

// Never prompt or stall: no password/host-key questions, bounded connect time.
const NONINTERACTIVE = ['-c', 'core.sshCommand=ssh -o BatchMode=yes -o ConnectTimeout=15'];

// Design §4.1: a new container's shared .ai/ starts from the remote's default branch when it commits
// one. Only .ai/ is checked out of a shallow, blob-less clone in a temp dir under the machine config
// dir, which is always removed.
export async function seedFromRemote(deps, remote, branch, destAi) {
  const config = configDir(deps.env, deps.homedir());
  mkdirSync(config, { recursive: true });
  const tmp = mkdtempSync(join(config, 'seed-'));
  const none = { seeded: false, files: 0, base: {}, warning: null, skipped: [] };
  const unreadable = (why) => ({ ...none, warning: `could not read the remote's .ai/ (${why}); the container starts with a fresh .ai/ layer` });
  try {
    const repo = join(tmp, 'repo');
    const clone = await deps.gitAsync(
      [...NONINTERACTIVE, 'clone', '--quiet', '--depth', '1', '--filter=blob:none', '--no-checkout', '--branch', branch, '--', remote, repo],
      { cwd: tmp },
    );
    if (clone.error || clone.status !== 0) return unreadable(reason(clone.stderr, clone.error));
    const listed = deps.git(['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', '.ai'], { cwd: repo });
    if (listed.error || listed.status !== 0) return unreadable(reason(listed.stderr, listed.error));
    if (!listed.stdout) return none;
    const checkout = await deps.gitAsync([...NONINTERACTIVE, 'checkout', '--quiet', 'HEAD', '--', '.ai'], { cwd: repo });
    if (checkout.error || checkout.status !== 0) return unreadable(reason(checkout.stderr, checkout.error));
    let stat = null;
    try {
      stat = lstatSync(join(repo, '.ai'));
    } catch {}
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return unreadable('.ai in the remote is not a directory');
    const { copied, skippedSymlinks } = copyTree(join(repo, '.ai'), destAi);
    return { seeded: true, files: copied.length, base: syncedState(join(repo, '.ai')).files, warning: null, skipped: skippedSymlinks };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
