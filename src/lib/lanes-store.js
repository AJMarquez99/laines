import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJson, writeFileAtomic, writeJson } from './jsonfile.js';
import { withLock } from './lock.js';
import { addActivity, emptyLanesState, parseLanesState } from './lanes-state.js';
import { fmtTs, renderBoard, safe } from './board.js';

// Lane names come from users: never let `constructor`, `__proto__` and friends resolve through
// Object.prototype.
export const getLane = (state, name) => (Object.hasOwn(state.lanes, name) ? state.lanes[name] : undefined);

export const readLanes = (ctx) => parseLanesState(readJson(ctx.paths.lanes, { onMissing: emptyLanesState }), ctx.paths.lanes);

export function writeBoard(ctx, state) {
  mkdirSync(dirname(ctx.paths.board), { recursive: true });
  const container = {
    id: ctx.id,
    portRange: ctx.portRange,
    hooksPolicy: ctx.config.hooks.policy,
    teardownMcp: ctx.config.teardown.mcp,
  };
  writeFileAtomic(ctx.paths.board, renderBoard({ container, state }));
}

function archiveOverflow(ctx, overflow, now) {
  if (!overflow.length) return;
  const file = join(ctx.paths.ai, 'archive', `${now.slice(0, 10)}_board-log.md`);
  mkdirSync(dirname(file), { recursive: true });
  const head = existsSync(file)
    ? ''
    : `# Board activity archive: ${ctx.id}\n\n_Entries rolled off the board's Activity Log, oldest first._\n\n`;
  const lines = overflow.map((a) => `- **${fmtTs(a.ts)}** · ${a.lane ? `\`${a.lane}\`: ` : ''}${safe(a.text)}`);
  appendFileSync(file, `${head}${lines.join('\n')}\n`);
}

// Every lane-state change goes through here: one lock, one validated read, one validated write of
// lanes.json, and a board regenerated from the result. If mutate throws or validation fails,
// nothing is written. Activity entries are validated before persisting; overflow is archived after.
export async function updateLanes(ctx, deps, mutate) {
  return withLock(ctx.paths.lock, async () => {
    const current = readLanes(ctx);
    const { state, result, activity = [] } = await mutate(structuredClone(current));
    let next = parseLanesState(state, ctx.paths.lanes);
    let allOverflow = [];
    for (const entry of activity) {
      const r = addActivity(next, entry, ctx.config.board.logLimit);
      next = r.state;
      allOverflow.push(...r.overflow.reverse());
    }
    // Validate the entire final state (including all activity entries) before writing anything.
    // This ensures malformed activity entries are caught and rejected without persisting.
    next = parseLanesState(next, ctx.paths.lanes);
    writeJson(ctx.paths.lanes, next);
    writeBoard(ctx, next);
    // Archive overflow only after successful writes.
    archiveOverflow(ctx, allOverflow, deps.now());
    return result;
  });
}
