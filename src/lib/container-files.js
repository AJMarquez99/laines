import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addPrivateIndexRow, hasIndexRow, removeIndexRow } from './agent-files.js';

// The files laines writes into every container's .ai/. They are `_`-prefixed (dot-ai's private
// class): never in a committed README.md, indexed in the folder's `_README.md`, never synced.
export const RUNBOOK = ['runbooks', 'lane-management.md', 'How to create, run, monitor and tear down lanes in this container'];
export const LANE_TEMPLATES = [
  ['templates', 'lane-ai-readme.md', 'Lane-local `.ai/README.md`: lane rules and where the shared knowledge lives'],
  ['templates', 'lane-context-readme.md', 'Lane-local `.ai/context/README.md`'],
  ['templates', 'lane-plans-readme.md', 'Lane-local `.ai/plans/README.md`'],
  ['templates', 'lane-local-instructions.md', 'Lane-local `CLAUDE.local.md` / `AGENTS.md` / `GEMINI.md`: lane identity and rules'],
];
const ALL = [RUNBOOK, ...LANE_TEMPLATES];

const present = (p) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

// Registers a laines `_` file in its folder's `_README.md`.
export const indexPrivate = (ai, [dir, name, answers]) => addPrivateIndexRow(join(ai, dir), `_${name}`, answers);

// Old-layout leftovers in a container's .ai/: an old-name file, or a laines row in README.md.
// Layout 2 (M4.6+) containers were written with `_` names from the start: any plain-named file is the
// project's own, so nothing is flagged or moved.
export const CURRENT_LAYOUT = 2;

export function unmigratedFiles(ai, layout = 1) {
  if (layout >= CURRENT_LAYOUT) return [];
  return ALL.flatMap(([dir, name]) => {
    const old = present(join(ai, dir, name));
    const row = hasIndexRow(join(ai, dir, 'README.md'), name);
    if (!old && !row) return [];
    const both = old && present(join(ai, dir, `_${name}`));
    return [{ dir, name, both }];
  });
}

// Moves a pre-M4.6 container's laines files to their `_` names. Never overwrites: when both names
// exist it leaves both and warns. Safe to run repeatedly.
export function migrateContainerFiles(ai, layout = 1) {
  if (layout >= CURRENT_LAYOUT) return { migrated: [], warnings: [] };
  const migrated = [];
  const warnings = [];
  for (const entry of ALL) {
    const [dir, name, answers] = entry;
    const old = join(ai, dir, name);
    const next = join(ai, dir, `_${name}`);
    if (present(old)) {
      if (present(next)) {
        warnings.push(`both ${dir}/${name} and ${dir}/_${name} exist: keep one by hand`);
        addPrivateIndexRow(join(ai, dir), `_${name}`, answers);
        continue;
      }
      renameSync(old, next);
      migrated.push(`${dir}/${name}`);
    }
    if (!existsSync(next)) {
      // Gone under both names: only the committed row is left, and it would dangle once stamped.
      if (removeIndexRow(join(ai, dir, 'README.md'), name)) migrated.push(`${dir}/${name}`);
      continue;
    }
    const rowGone = removeIndexRow(join(ai, dir, 'README.md'), name);
    const rowAdded = addPrivateIndexRow(join(ai, dir), `_${name}`, answers) === 'written';
    if ((rowGone || rowAdded) && !migrated.includes(`${dir}/${name}`)) migrated.push(`${dir}/${name}`);
  }
  return { migrated, warnings };
}

// laines' own old path strings inside its five `_` files (the migration renamed the files but left
// these references). Matched with the folder prefix, so prose about other files is untouched.
const STALE = ALL.map(([dir, name]) => [`${dir}/${name}`, `${dir}/_${name}`]);

// Rewrites the stale paths (`dryRun`: only reports); returns the `<dir>/_<name>` files changed.
// Idempotent: the new spelling contains no old one.
export function rewriteStalePaths(ai, { dryRun = false } = {}) {
  return ALL.flatMap(([dir, name]) => {
    const file = join(ai, dir, `_${name}`);
    if (!existsSync(file)) return [];
    const cur = readFileSync(file, 'utf8');
    const next = STALE.reduce((t, [from, to]) => t.split(from).join(to), cur);
    if (next === cur) return [];
    if (!dryRun) writeFileSync(file, next);
    return [`${dir}/_${name}`];
  });
}
