import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { readJson } from './jsonfile.js';
import { configDir, containerPaths } from './paths.js';
import { loadIndex } from './machine-index.js';
import { InvalidInputError, MalformedConfigError, NotAContainerError } from './errors.js';

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
// carries a marker with the same id. The container is never searched for.
export function detectLane(start) {
  const root = findRepoRoot(start);
  if (!root) return null;
  const m = readJsonQuiet(join(root, '.ai', '.lane.json'));
  if (!m || typeof m.lane !== 'string' || typeof m.container !== 'string' || typeof m.containerId !== 'string') return null;
  const c = readJsonQuiet(join(m.container, '.laines', 'container.json'));
  if (!c || c.id !== m.containerId) return null;
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
  const paths = containerPaths(root);
  const marker = readJson(paths.marker);
  if (!marker.id) throw new MalformedConfigError(paths.marker, 'no id');
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
