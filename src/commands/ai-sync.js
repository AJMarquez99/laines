import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { laneFrom, loadContainer } from '../lib/container.js';
import { getLane, readLanes, updateLanes } from '../lib/lanes-store.js';
import { assertLaneDir } from '../lib/containment.js';
import { planSync, readAiBase, repoCommitsAi, syncedState, writeAiBase } from '../lib/ai-tree.js';
import { operationInProgress } from '../lib/lane-git.js';
import { writeFileAtomic } from '../lib/jsonfile.js';
import { appendAudit } from '../lib/audit.js';
import { BlockedError, InvalidInputError } from '../lib/errors.js';

function copyOrDelete(from, to) {
  if (existsSync(from)) {
    mkdirSync(dirname(to), { recursive: true });
    writeFileAtomic(to, readFileSync(from));
  } else {
    rmSync(to, { force: true });
  }
}

// Design §4.3: an explicit three-way sync between the container's live .ai/ and a lane's committed .ai/.
export async function runAiSync(opts, deps) {
  const ctx = loadContainer(opts, deps);
  const name = laneFrom(opts, deps, ctx);
  const lane = getLane(readLanes(ctx), name);
  if (!lane) throw new InvalidInputError(`No lane named ${name}. See \`laines list\`.`);
  if (lane.state === 'closed') throw new InvalidInputError(`Lane ${name} is closed.`);
  const laneDir = join(ctx.root, lane.repos[0].path);
  const real = assertLaneDir(ctx.root, laneDir, lane.repos[0].path);
  if (!real || !existsSync(join(real, '.git'))) throw new InvalidInputError(`${laneDir} is missing or not a git clone.`);
  const empty = { dryRun: Boolean(opts.dryRun), lane: name, toLane: [], toContainer: [], deleted: { lane: [], container: [] }, refused: [], conflicts: [] };
  if (!repoCommitsAi(deps, real)) {
    return { ...empty, applies: false, note: 'This repository does not commit .ai/: knowledge stays in the container.' };
  }
  const op = operationInProgress(deps, real);
  if (op) throw new BlockedError(`Lane ${name} has a git operation in progress (${op}). Finish or abort it, then run \`laines ai sync ${name}\`.`);
  const laneAi = join(real, '.ai');
  if (existsSync(laneAi) && lstatSync(laneAi).isSymbolicLink()) throw new BlockedError(`${laneAi} is a symbolic link: refusing to sync through it.`);

  const c = syncedState(ctx.paths.ai);
  const l = syncedState(laneAi);
  const base = readAiBase(ctx.paths);
  const links = [...new Set([...c.symlinks, ...l.symlinks])].sort();
  const plan = planSync({ container: c.files, lane: l.files, base, refused: links });
  const refused = [...new Set([...links, ...plan.refused])].sort();
  const nextBase = plan.nextBase;
  const result = {
    ...empty,
    applies: true,
    toLane: plan.toLane,
    toContainer: plan.toContainer,
    deleted: {
      lane: plan.toLane.filter((rel) => !Object.hasOwn(c.files, rel)),
      container: plan.toContainer.filter((rel) => !Object.hasOwn(l.files, rel)),
    },
    refused,
    conflicts: plan.conflicts,
  };
  if (opts.dryRun) return result;

  for (const rel of plan.toLane) copyOrDelete(join(ctx.paths.ai, rel), join(laneAi, rel));
  for (const rel of plan.toContainer) copyOrDelete(join(laneAi, rel), join(ctx.paths.ai, rel));
  writeAiBase(ctx.paths, nextBase);
  const moved = plan.toLane.length + plan.toContainer.length;
  if (moved || plan.conflicts.length) {
    const now = deps.now();
    const text = `.ai/ synced: ${plan.toLane.length} to the lane, ${plan.toContainer.length} to the container${plan.conflicts.length ? `, ${plan.conflicts.length} conflict(s)` : ''}`;
    await updateLanes(ctx, deps, (state) => ({ state, result: null, activity: [{ ts: now, lane: name, text }] }));
    appendAudit(ctx.paths.audit, { ts: now, action: 'ai-sync', container: ctx.id, lane: name, toLane: plan.toLane.length, toContainer: plan.toContainer.length, conflicts: plan.conflicts.length }, { warn: deps.warn });
  }
  if (plan.conflicts.length) {
    throw new BlockedError([
      `.ai/ sync of ${name} stopped on ${plan.conflicts.length} conflict(s): changed in both the container and the lane.`,
      ...plan.conflicts.flatMap((rel) => [`  ${rel}`, `    container: ${join(ctx.paths.ai, rel)}`, `    lane:      ${join(laneAi, rel)}`]),
      'Everything else was synced. Make the two copies identical (edit the container copy to what you want, copy it over the lane copy), then run',
      `\`laines ai sync ${name}\` again.`,
    ].join('\n'));
  }
  return result;
}
