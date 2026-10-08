import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { gitOut } from './git.js';
import { readLanes } from './lanes-store.js';

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

// Informational only: which other open lanes also hold each unpushed ref's tip, as a local branch or
// tag. A reflog or remote-tracking ref is not "held". It never exempts a commit from the check.
export function siblingHoldings(deps, ctx, laneName, refs) {
  const siblings = Object.entries(readLanes(ctx).lanes)
    .filter(([name, l]) => name !== laneName && l.state !== 'closed')
    .map(([name, l]) => ({ name, dir: join(ctx.root, l.repos[0].path) }))
    .filter((l) => existsSync(join(l.dir, '.git')));
  const mine = join(ctx.root, readLanes(ctx).lanes[laneName].repos[0].path);
  return refs.map(({ ref, commits }) => {
    const tip = deps.git(['rev-parse', '--verify', '-q', ref], { cwd: mine });
    const sha = tip.status === 0 ? tip.stdout.trim() : '';
    const heldBy = [];
    for (const { name, dir } of sha ? siblings : []) {
      const has = deps.git(['cat-file', '-e', `${sha}^{commit}`], { cwd: dir });
      if (has.error || has.status !== 0) continue;
      const found = deps.git(['for-each-ref', '--contains', sha, '--format=%(refname)', 'refs/heads', 'refs/tags'], { cwd: dir });
      if (found.error || found.status !== 0) continue;
      const names = found.stdout.split('\n').filter(Boolean);
      if (names.length) heldBy.push({ lane: name, refs: names });
    }
    return { ref, commits, heldBy };
  });
}

const holdingLine = (h) =>
  `  - ${h.ref} (${h.commits} commits): ${h.heldBy.length ? `also in ${h.heldBy.map((x) => `${x.lane} (${x.refs.join(', ')})`).join('; ')}` : 'held by no other lane'}`;

export const holdingLines = (holdings) => (holdings ?? []).map(holdingLine);

const IN_PROGRESS = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG'];

// A merge, rebase, cherry-pick, revert or bisect half-done in repoDir, or null.
export function operationInProgress(deps, repoDir) {
  const args = ['rev-parse'];
  for (const name of IN_PROGRESS) {
    args.push('--git-path', name);
  }
  const lines = gitOut(deps, args, repoDir).trim().split('\n');
  for (let i = 0; i < IN_PROGRESS.length; i++) {
    const rel = lines[i];
    if (rel && existsSync(isAbsolute(rel) ? rel : join(repoDir, rel))) {
      return IN_PROGRESS[i];
    }
  }
  return null;
}
