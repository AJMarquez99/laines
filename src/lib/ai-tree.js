import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { z } from 'zod';
import { BlockedError } from './errors.js';
import { checksum } from './hooks.js';
import { readJson, writeFileAtomic, writeJson } from './jsonfile.js';
import { parseWith } from './schema.js';
import { gitOut } from './git.js';

// laines writes these into every container's .ai/: they describe the container, not the project.
const LAINES_OWNED = new Set([
  // Pre-M4.6 names, kept so an unmigrated container still never syncs them; the `_` names are excluded by the `_` rule.
  'runbooks/lane-management.md',
  'templates/lane-ai-readme.md',
  'templates/lane-context-readme.md',
  'templates/lane-plans-readme.md',
  'templates/lane-local-instructions.md',
]);

// Design §4.3: the synced set is .ai/ minus lane-owned, local-only and laines-owned paths
// (laines writes board-log overflow and torn-down lanes' plans into archive/).
export function isSynced(rel) {
  const parts = rel.split('/');
  if (parts[0] === 'context' || parts[0] === 'plans' || parts[0] === 'archive') return false;
  if (parts.some((p) => p.startsWith('_'))) return false;
  if (rel === 'README.md' || rel === '.lane.json') return false;
  return !LAINES_OWNED.has(rel);
}

const gone = (fn) => {
  try {
    return fn();
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
};

// Every entry under dir as '/'-separated relative paths. Symlinks are listed, never followed.
// Throws BlockedError if dir itself is a symlink (including dangling symlinks). A missing dir is
// empty; an entry that vanishes mid-walk (an atomic write's temp file, an editor save) is skipped,
// never taken as the end of the listing. Any other error propagates.
export function walk(dir) {
  const files = [];
  const symlinks = [];
  const visit = (abs, rel) => {
    for (const name of (gone(() => readdirSync(abs)) ?? []).sort()) {
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const st = gone(() => lstatSync(childAbs));
      if (!st) continue;
      if (st.isSymbolicLink()) symlinks.push(childRel);
      else if (st.isDirectory()) visit(childAbs, childRel);
      else if (st.isFile()) files.push(childRel);
    }
  };
  const st = gone(() => lstatSync(dir));
  if (st?.isSymbolicLink()) throw new BlockedError(`${dir} is a symbolic link: refusing to read through it.`);
  if (st?.isDirectory()) visit(dir, '');
  return { files: files.sort(), symlinks: symlinks.sort() };
}

const nfc = (s) => s.normalize('NFC');
const nfcKeys = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [nfc(k), v]));

// Keys are NFC: macOS can list a name decomposed (NFD) that git and the other side hold precomposed,
// and one file must not look like two. `names` maps each key to the name on disk (still NFD on Linux).
export function syncedState(aiDir) {
  const { files, symlinks } = walk(aiDir);
  const names = new Map();
  for (const rel of files.filter(isSynced)) {
    const key = nfc(rel);
    if (names.has(key)) throw new BlockedError(`${join(aiDir, names.get(key))} and ${join(aiDir, rel)} are one name in two Unicode forms: rename or remove one, then retry.`);
    names.set(key, rel);
  }
  return {
    files: Object.fromEntries([...names].map(([key, rel]) => [key, checksum(readFileSync(join(aiDir, rel)))])),
    names: Object.fromEntries(names),
    symlinks: [...new Set(symlinks.filter(isSynced).map(nfc))].sort(),
  };
}

// The name on disk for a syncedState key (the key itself when that side does not have it).
export const onDisk = (names, rel) => (Object.hasOwn(names, rel) ? names[rel] : rel);

// Where aiDir really is, whether or not it exists yet. Taken before any write, so a later swap of
// aiDir itself for a symlink cannot move it.
export const realAi = (aiDir) => join(realpathSync(dirname(aiDir)), basename(aiDir));

// The plan comes from a walk that never follows a link, but a directory under .ai/ can be swapped
// for one before the write. Refuse unless what exists of path's directory resolves inside side.root.
function assertInside(side, path) {
  let dir = dirname(path);
  while (dir !== side.dir && dirname(dir) !== dir && !lstatSync(dir, { throwIfNoEntry: false })) dir = dirname(dir);
  if (!lstatSync(dir, { throwIfNoEntry: false })) return;
  const real = gone(() => realpathSync(dir));
  if (real === side.root || real?.startsWith(side.root + sep)) return;
  throw new BlockedError(`${dir} resolves to ${real ?? 'nothing (a dangling link)'}, outside ${side.dir} (swapped for a symbolic link?): refusing to write or delete through it.`);
}

// Copies rel from one side to the other, or deletes it from `to` when `from` no longer has it.
// A side is { dir, root: realAi(dir), names } with names from syncedState.
export function copyOrDelete(from, to, rel) {
  const src = join(from.dir, onDisk(from.names, rel));
  const dest = join(to.dir, Object.hasOwn(to.names, rel) ? to.names[rel] : onDisk(from.names, rel));
  assertInside(to, dest);
  const st = Object.hasOwn(from.names, rel) ? lstatSync(src, { throwIfNoEntry: false }) : null;
  if (!st) {
    rmSync(dest, { force: true });
    return;
  }
  assertInside(from, src);
  if (st.isSymbolicLink()) throw new BlockedError(`${src} is a symbolic link: refusing to sync through it.`);
  const data = readFileSync(src);
  mkdirSync(dirname(dest), { recursive: true });
  assertInside(to, dest);
  writeFileAtomic(dest, data);
}

// Copies every regular file of src into dest; symlinks are skipped and reported.
// Throws BlockedError if dest has symlinks to avoid writing through them.
export function copyTree(src, dest) {
  const srcWalk = walk(src);
  const destWalk = walk(dest);
  if (destWalk.symlinks.length > 0) {
    throw new BlockedError(`${dest} destination has symlinks: refusing to write through them.`);
  }
  for (const rel of srcWalk.files) {
    const to = join(dest, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(src, rel), to);
  }
  return { copied: srcWalk.files, skippedSymlinks: srcWalk.symlinks };
}

const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined);

// Check if rel equals or sits under any refused rel (symlinked directory).
const isRefused = (rel, refused) => refused.some((r) => rel === r || rel.startsWith(r + '/'));

// Design §4.3, per file: c = container, l = lane, b = base (undefined = absent).
// refused: rels of symlinked directories; files under them are never synced.
// Keys are normalised to NFC (a base written before keys were NFC may hold NFD ones).
export function planSync({ container: c0, lane: l0, base: b0, refused: r0 = [] }) {
  const [container, lane, base] = [c0, l0, b0].map(nfcKeys);
  const refused = r0.map(nfc);
  const paths = [...new Set([...Object.keys(container), ...Object.keys(lane), ...Object.keys(base)])].sort();
  const toLane = [];
  const toContainer = [];
  const conflicts = [];
  const refusedRels = [];
  const next = [];
  for (const rel of paths) {
    if (isRefused(rel, refused)) {
      refusedRels.push(rel);
      const b = own(base, rel);
      if (b !== undefined) next.push([rel, b]);
      continue;
    }
    const c = own(container, rel);
    const l = own(lane, rel);
    const b = own(base, rel);
    if (c === l) {
      if (c !== undefined) next.push([rel, c]);
    } else if (l === b) {
      toLane.push(rel);
      if (c !== undefined) next.push([rel, c]);
    } else if (c === b) {
      toContainer.push(rel);
      if (l !== undefined) next.push([rel, l]);
    } else {
      conflicts.push(rel);
      if (b !== undefined) next.push([rel, b]);
    }
  }
  // fromEntries defines own properties, so a "__proto__" path stays data.
  return { toLane, toContainer, conflicts, refused: refusedRels.sort(), nextBase: Object.fromEntries(next) };
}

export function aiDrift(containerAi, laneAi) {
  const c = syncedState(containerAi).files;
  const l = syncedState(laneAi).files;
  return [...new Set([...Object.keys(c), ...Object.keys(l)])].filter((rel) => own(c, rel) !== own(l, rel)).length;
}

const Sha = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const BaseSchema = z.strictObject({
  version: z.literal(2),
  lanes: z.record(z.string(), z.record(z.string(), Sha)),
});

export const aiSyncFile = (paths) => join(paths.laines, 'ai-sync.json');

// Design §4.3: one base per lane (`{ version: 2, lanes: { <lane>: { <rel>: sha } } }`). A shared
// base cannot tell "this lane is behind" from "this lane deleted it". A file without `lanes` (the
// pre-release version 1) means no base for any lane; anything else malformed throws.
export function readAiBases(paths) {
  const file = aiSyncFile(paths);
  const raw = readJson(file, { onMissing: () => ({ version: 2, lanes: {} }) });
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && !Object.hasOwn(raw, 'lanes')) return {};
  return parseWith(BaseSchema, raw, file).lanes;
}

export const readAiBase = (paths, lane) => own(readAiBases(paths), lane) ?? {};

// Read-modify-write of one lane's entry (null removes it); callers that may race hold the container
// lock. Removing an entry that is not there writes nothing.
export function writeAiBase(paths, lane, base) {
  const lanes = { ...readAiBases(paths) };
  if (base === null) {
    if (!Object.hasOwn(lanes, lane)) return;
    delete lanes[lane];
  } else {
    Object.defineProperty(lanes, lane, { value: base, enumerable: true, writable: true, configurable: true });
  }
  writeJson(aiSyncFile(paths), { version: 2, lanes });
}

// repoDir must be the worktree toplevel (pathspec is cwd-relative).
export function repoCommitsAi(deps, repoDir) {
  return gitOut(deps, ['ls-files', '-z', '--', '.ai'], repoDir)
    .split('\0')
    .some((f) => f.startsWith('.ai/') && isSynced(f.slice('.ai/'.length)));
}
