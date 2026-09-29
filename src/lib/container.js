import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NotAContainerError } from './errors.js';

// No upward search: a command runs against the given directory or fails clearly.
export function resolveContainer(dir) {
  const root = resolve(dir);
  if (existsSync(join(root, '.laines', 'container.json'))) return realpathSync(root);
  throw new NotAContainerError(root);
}
