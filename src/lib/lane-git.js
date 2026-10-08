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
  const lanes = readLanes(ctx).lanes;
  const dirOf = (l) => join(ctx.root, l.repos[0].path);
  const siblings = Object.entries(lanes)
    .filter(([name, l]) => name !== laneName && l.state !== 'closed' && existsSync(join(dirOf(l), '.git')))
    .map(([name, l]) => ({ name, dir: dirOf(l) }));
  const mine = dirOf(lanes[laneName]);
  return refs.map(({ ref, commits }) => {
    const tip = deps.git(['rev-parse', '--verify', '-q', `${ref}^{commit}`], { cwd: mine });
    const sha = tip.status === 0 ? tip.stdout.trim() : '';
    const heldBy = [];
    for (const { name, dir } of sha ? siblings : []) {
      // A sibling without the object fails here and is skipped.
      const found = deps.git(['for-each-ref', '--contains', sha, '--format=%(refname)', 'refs/heads', 'refs/tags'], { cwd: dir });
      if (found.error || found.status !== 0) continue;
      const names = found.stdout.split('\n').filter(Boolean);
      if (names.length) heldBy.push({ lane: name, refs: names });
    }
    return { ref, commits, heldBy };
  });
}

// What a human was shown before forcing: unpushed ref tips, dirty files, stash count. A forced run with
// a different fingerprint is refused, so nothing is discarded that the human did not see.
export function forceFingerprint(deps, laneDir, checks) {
  const refs = checks.refs.map(({ ref }) => {
    const r = deps.git(['rev-parse', '--verify', '-q', `${ref}^{commit}`], { cwd: laneDir });
    return { ref, tip: r.status === 0 ? r.stdout.trim() : '' };
  });
  return JSON.stringify({ refs, dirty: [...checks.dirty].sort(), stashes: checks.stashes });
}

const holdingLine = (h) =>
  `  - ${h.ref} (${h.commits} commits): ${h.heldBy.length ? `also in ${h.heldBy.map((x) => `${x.lane} (${x.refs.join(', ')})`).join('; ')}` : 'held by no other lane'}`;

// The header and one line per ref, shared by the refusal and the table; empty when there is nothing to say.
export const holdingLines = (holdings) =>
  holdings?.length ? ['Other lanes holding these commits (informational; they do not make removal safe):', ...holdings.map(holdingLine)] : [];

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
