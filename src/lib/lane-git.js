import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { gitOut } from './git.js';

// The loss condition is commit-level, not branch-level: any commit reachable from a local ref but
// on no remote dies with the clone. Comparing against upstream misses branches with no upstream,
// and walking refs/heads misses backup refs and tags. Stashes are counted on their own.
export function unpushedWork(deps, laneDir) {
  const g = (args) => gitOut(deps, args, laneDir);
  const lines = (s) => s.split('\n').filter(Boolean);
  const dirty = lines(g(['status', '--porcelain']));
  const stashes = lines(g(['stash', 'list'])).length;
  const unpushed = Number(g(['rev-list', '--count', '--exclude=refs/stash', '--all', '--not', '--remotes']).trim()) || 0;
  const branch = g(['branch', '--show-current']).trim();
  // A detached HEAD is a ref too; it is named so the message points at the commits.
  const refs = unpushed === 0
    ? []
    : [...(branch ? [] : ['HEAD']), ...lines(g(['for-each-ref', '--format=%(refname)']))]
      .filter((ref) => !ref.startsWith('refs/remotes/') && ref !== 'refs/stash')
      .map((ref) => ({ ref, commits: Number(g(['rev-list', '--count', ref, '--not', '--remotes']).trim()) || 0 }))
      .filter((r) => r.commits > 0);
  const noUpstream = branch && deps.git(['rev-parse', '--abbrev-ref', '@{u}'], { cwd: laneDir }).status !== 0 ? branch : null;
  const problems = [];
  if (dirty.length) problems.push(`${dirty.length} uncommitted change(s)`);
  if (stashes) problems.push(`${stashes} stash entr${stashes === 1 ? 'y' : 'ies'}`);
  if (unpushed) problems.push(`${unpushed} commit(s) that exist on no remote: ${refs.map((r) => `${r.ref} (${r.commits})`).join(', ')}`);
  return { dirty, stashes, unpushed, refs, noUpstream, problems };
}

const IN_PROGRESS = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG'];

// A merge, rebase, cherry-pick, revert or bisect half-done in repoDir, or null.
export function operationInProgress(deps, repoDir) {
  return IN_PROGRESS.find((name) => {
    const rel = gitOut(deps, ['rev-parse', '--git-path', name], repoDir).trim();
    return existsSync(isAbsolute(rel) ? rel : join(repoDir, rel));
  }) ?? null;
}
