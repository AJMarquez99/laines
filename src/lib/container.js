import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { readJson } from './jsonfile.js';
import { configDir, containerPaths } from './paths.js';
import { loadIndex } from './machine-index.js';
import { LANE_NAME } from './ids.js';
import { BlockedError, InvalidInputError, MalformedConfigError, NotAContainerError } from './errors.js';

// No upward search: a command runs against the given directory or fails clearly.
export function resolveContainer(dir) {
  const root = resolve(dir);
  if (existsSync(join(root, '.laines', 'container.json'))) return realpathSync(root);
  throw new NotAContainerError(root);
}

export function findRepoRoot(start) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

const readJsonQuiet = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// Spec §7.1: lane mode only when the lane marker sits at the repo root AND the container it names
// carries a marker with the same id AND the repo root really is <container>/<lane> (a copied lane
// directory carries a valid-looking marker). The container is never searched for.
export function detectLane(start) {
  const root = findRepoRoot(start);
  if (!root) return null;
  const m = readJsonQuiet(join(root, '.ai', '.lane.json'));
  if (
    !m ||
    typeof m.lane !== 'string' || !LANE_NAME.test(m.lane) ||
    typeof m.container !== 'string' || !isAbsolute(m.container) ||
    typeof m.containerId !== 'string' ||
    !Number.isInteger(m.number) || m.number < 1
  ) {
    return null;
  }
  const c = readJsonQuiet(join(m.container, '.laines', 'container.json'));
  if (!c || c.id !== m.containerId) return null;
  try {
    if (realpathSync(root) !== join(realpathSync(m.container), m.lane)) return null;
  } catch {
    return null;
  }
  return { lane: m.lane, number: m.number, containerId: m.containerId, container: m.container, root };
}

export function containerDirFrom(opts, deps) {
  if (opts.container) return isAbsolute(opts.container) ? opts.container : resolve(deps.cwd(), opts.container);
  const cwd = deps.cwd();
  if (existsSync(join(cwd, '.laines', 'container.json'))) return cwd;
  const lane = detectLane(cwd);
  return lane ? lane.container : cwd;
}

export function loadContainer(opts, deps) {
  const root = resolveContainer(containerDirFrom(opts, deps));
  // Spec §9.1: lane directories are deleted relative to the root, so never the filesystem root or home.
  const home = deps.homedir();
  if (root === parse(root).root || (existsSync(home) && root === realpathSync(home))) {
    throw new BlockedError(`Refusing to operate on a container at ${root}.`);
  }
  const paths = containerPaths(root);
  const marker = readJson(paths.marker);
  if (!marker || typeof marker !== 'object' || !marker.id) throw new MalformedConfigError(paths.marker, 'no id');
  const config = loadConfig(paths.config);
  const indexDir = configDir(deps.env, deps.homedir());
  const entry = loadIndex(indexDir).containers.find((c) => c.path === root);
  if (!entry) {
    throw new MalformedConfigError(join(indexDir, 'containers.json'), `container ${root} is not registered; run \`laines doctor\``);
  }
  return { root, paths, id: marker.id, config, portRange: entry.portRange };
}

export function laneFrom(opts, deps) {
  if (opts.lane) return opts.lane;
  const lane = detectLane(deps.cwd());
  if (lane) return lane.lane;
  throw new InvalidInputError('Name the lane (for example `laines report lane_2 ...`) or run the command inside a lane.');
}
