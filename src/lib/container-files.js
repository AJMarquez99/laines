import { existsSync, lstatSync, renameSync } from 'node:fs';
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
export function unmigratedFiles(ai) {
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
export function migrateContainerFiles(ai) {
  const migrated = [];
  const warnings = [];
  for (const entry of ALL) {
    const [dir, name, answers] = entry;
    const old = join(ai, dir, name);
    const next = join(ai, dir, `_${name}`);
    if (present(old)) {
      if (present(next)) {
        warnings.push(`both ${dir}/${name} and ${dir}/_${name} exist: keep one by hand`);
        continue;
      }
      renameSync(old, next);
      migrated.push(`${dir}/${name}`);
    }
    if (!existsSync(next)) continue;
    const rowGone = removeIndexRow(join(ai, dir, 'README.md'), name);
    const rowAdded = addPrivateIndexRow(join(ai, dir), `_${name}`, answers) === 'written';
    if ((rowGone || rowAdded) && !migrated.includes(`${dir}/${name}`)) migrated.push(`${dir}/${name}`);
  }
  return { migrated, warnings };
}
