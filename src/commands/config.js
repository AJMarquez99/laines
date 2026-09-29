import { loadConfig } from '../config.js';
import { containerPaths } from '../lib/paths.js';
import { containerDirFrom, resolveContainer } from '../lib/container.js';
import { getPath } from '../lib/jsonfile.js';
import { InvalidInputError } from '../lib/errors.js';

export async function runConfigGet(opts, deps) {
  const root = resolveContainer(containerDirFrom(opts, deps));
  const config = loadConfig(containerPaths(root).config);
  if (!opts.key) return config;
  const value = getPath(config, opts.key);
  if (value === undefined) throw new InvalidInputError(`Unknown config key "${opts.key}".`);
  return { key: opts.key, value };
}
