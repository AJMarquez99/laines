import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
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

export function removeLaneDir(root, laneDir, name) {
  const real = assertLaneDir(root, laneDir, name);
  if (!real) return false;
  rmSync(real, { recursive: true, force: true });
  return true;
}
