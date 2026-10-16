import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { BlockedError } from './errors.js';

// Spec §9.1: before anything under a lane is touched destructively, the path must be
// <container>/<lane> both lexically and through realpath, and must not be a symlink.
// `root` must already be a realpath (loadContainer guarantees it).
export function assertLaneDir(root, laneDir, name) {
  const lexical = resolve(laneDir);
  const refuse = (why) => {
    throw new BlockedError(`Refusing to touch ${lexical}: ${why}.`);
  };
  if (dirname(lexical) !== root || basename(lexical) !== name) refuse(`it is not ${name}/ directly inside the container ${root}`);
  if (!existsSync(lexical)) return null;
  if (lstatSync(lexical).isSymbolicLink()) refuse('it is a symbolic link');
  const real = realpathSync(lexical);
  if (dirname(real) !== root || basename(real) !== name) refuse(`it resolves to ${real}, outside the container`);
  return real;
}

// A clone checks out whatever the repository commits: a symlinked .ai/, .ai/context, .ai/plans or
// .claude would send lane-file writes and teardown's archive/delete outside the lane.
export function assertNoLaneLinks(laneDir) {
  for (const rel of ['.ai', '.ai/context', '.ai/plans', '.claude']) {
    const path = join(laneDir, rel);
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new BlockedError(`${path} is a symbolic link (committed by the repository?): refusing to write, archive or delete through it. Remove the link from the lane, then retry.`);
    }
  }
}

export function removeLaneDir(root, laneDir, name) {
  const real = assertLaneDir(root, laneDir, name);
  if (!real) return false;
  rmSync(real, { recursive: true, force: true });
  return true;
}
