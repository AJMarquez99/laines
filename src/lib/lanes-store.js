import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJson, writeJson } from './jsonfile.js';
import { withLock } from './lock.js';
import { addActivity, emptyLanesState, parseLanesState } from './lanes-state.js';
import { fmtTs, oneLine, renderBoard } from './board.js';

export const readLanes = (ctx) => parseLanesState(readJson(ctx.paths.lanes, { onMissing: emptyLanesState }), ctx.paths.lanes);

export function writeBoard(ctx, state) {
  mkdirSync(dirname(ctx.paths.board), { recursive: true });
  const container = {
    id: ctx.id,
    portRange: ctx.portRange,
    hooksPolicy: ctx.config.hooks.policy,
    teardownMcp: ctx.config.teardown.mcp,
  };
  writeFileSync(ctx.paths.board, renderBoard({ container, state }));
}

function archiveOverflow(ctx, overflow, now) {
  if (!overflow.length) return;
  const file = join(ctx.paths.ai, 'archive', `${now.slice(0, 10)}_board-log.md`);
  mkdirSync(dirname(file), { recursive: true });
  const head = existsSync(file)
    ? ''
    : `# Board activity archive: ${ctx.id}\n\n_Entries rolled off the board's Activity Log, newest first within each batch._\n\n`;
  const lines = overflow.map((a) => `- **${fmtTs(a.ts)}** · ${a.lane ? `\`${a.lane}\`: ` : ''}${oneLine(a.text)}`);
  appendFileSync(file, `${head}${lines.join('\n')}\n`);
}

// Every lane-state change goes through here: one lock, one validated read, one validated write of
// lanes.json, and a board regenerated from the result. If mutate throws, nothing is written.
export async function updateLanes(ctx, deps, mutate) {
  return withLock(ctx.paths.lock, async () => {
    const current = readLanes(ctx);
    const { state, result, activity = [] } = await mutate(structuredClone(current));
    let next = parseLanesState(state, ctx.paths.lanes);
    for (const entry of activity) {
      const r = addActivity(next, entry, ctx.config.board.logLimit);
      next = r.state;
      archiveOverflow(ctx, r.overflow, deps.now());
    }
    writeJson(ctx.paths.lanes, next);
    writeBoard(ctx, next);
    return result;
  });
}
