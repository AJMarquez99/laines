import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { checksum } from './hooks.js';
import { readJson, writeJson } from './jsonfile.js';
import { parseWith } from './schema.js';
import { gitOut } from './git.js';

// laines writes these into every container's .ai/: they describe the container, not the project.
const LAINES_OWNED = new Set([
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

// Every entry under dir as '/'-separated relative paths. Symlinks are listed, never followed.
export function walk(dir) {
  const files = [];
  const symlinks = [];
  const visit = (abs, rel) => {
    for (const name of readdirSync(abs).sort()) {
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const st = lstatSync(childAbs);
      if (st.isSymbolicLink()) symlinks.push(childRel);
      else if (st.isDirectory()) visit(childAbs, childRel);
      else if (st.isFile()) files.push(childRel);
    }
  };
  if (existsSync(dir) && lstatSync(dir).isDirectory()) visit(dir, '');
  return { files: files.sort(), symlinks: symlinks.sort() };
}

export function syncedState(aiDir) {
  const { files, symlinks } = walk(aiDir);
  return {
    files: Object.fromEntries(files.filter(isSynced).map((rel) => [rel, checksum(readFileSync(join(aiDir, rel)))])),
    symlinks: symlinks.filter(isSynced),
  };
}

// Copies every regular file of src into dest; symlinks are skipped and reported.
export function copyTree(src, dest) {
  const { files, symlinks } = walk(src);
  for (const rel of files) {
    const to = join(dest, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(src, rel), to);
  }
  return { copied: files, skippedSymlinks: symlinks };
}

const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined);

// Design §4.3, per file: c = container, l = lane, b = base (undefined = absent).
export function planSync({ container, lane, base }) {
  const paths = [...new Set([...Object.keys(container), ...Object.keys(lane), ...Object.keys(base)])].sort();
  const toLane = [];
  const toContainer = [];
  const conflicts = [];
  const next = [];
  for (const rel of paths) {
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
  return { toLane, toContainer, conflicts, nextBase: Object.fromEntries(next) };
}

export function aiDrift(containerAi, laneAi) {
  const c = syncedState(containerAi).files;
  const l = syncedState(laneAi).files;
  return [...new Set([...Object.keys(c), ...Object.keys(l)])].filter((rel) => own(c, rel) !== own(l, rel)).length;
}

const BaseSchema = z.strictObject({
  version: z.literal(1),
  base: z.record(z.string(), z.string().regex(/^sha256:[0-9a-f]{64}$/)),
});

export const aiSyncFile = (paths) => join(paths.laines, 'ai-sync.json');

export const readAiBase = (paths) =>
  parseWith(BaseSchema, readJson(aiSyncFile(paths), { onMissing: () => ({ version: 1, base: {} }) }), aiSyncFile(paths)).base;

export const writeAiBase = (paths, base) => writeJson(aiSyncFile(paths), { version: 1, base });

export function repoCommitsAi(deps, repoDir) {
  return gitOut(deps, ['ls-files', '-z', '--', '.ai'], repoDir)
    .split('\0')
    .some((f) => f.startsWith('.ai/') && isSynced(f.slice('.ai/'.length)));
}
