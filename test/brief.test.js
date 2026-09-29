import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBrief } from '../src/lib/brief.js';
import { runBrief } from '../src/commands/brief.js';
import { loadContainer } from '../src/lib/container.js';
import { updateLanes } from '../src/lib/lanes-store.js';
import { InvalidInputError } from '../src/lib/errors.js';
import { cleanupTmp, setupContainer, runCli } from './helpers.js';

afterEach(cleanupTmp);

const record = (over = {}) => ({
  number: 1,
  repos: [{ name: 'my-app', path: 'lane_1', branch: 'feat/x' }],
  ports: [20000, 20009],
  state: 'active',
  status: 'in-progress',
  task: 'webhooks',
  blocked: null,
  kept: null,
  created: '2026-09-29T12:00:00.000Z',
  updated: '2026-09-29T12:00:00.000Z',
  closed: null,
  ...over,
});

async function withLane(over) {
  const s = await setupContainer();
  const ctx = loadContainer({ container: s.container }, s.deps);
  await updateLanes(ctx, s.deps, (state) => {
    state.lanes.lane_1 = record(over);
    return { state, result: null };
  });
  const laneDir = join(s.container, 'lane_1');
  mkdirSync(join(laneDir, '.git'), { recursive: true });
  mkdirSync(join(laneDir, '.ai', 'context'), { recursive: true });
  writeFileSync(join(laneDir, 'CLAUDE.md'), 'repo rules\n');
  writeFileSync(join(laneDir, '.ai', '.lane.json'), JSON.stringify({ lane: 'lane_1', number: 1, containerId: 'my-app', container: s.container }));
  return { ...s, ctx, laneDir };
}

describe('brief', () => {
  it('lists existing files to read, the rules and the board entry', async () => {
    const { ctx, container, laneDir } = await withLane();
    const b = buildBrief(ctx, 'lane_1', record());
    expect(b).toMatchObject({ lane: 'lane_1', id: 'my-app/lane_1', path: laneDir, branch: 'feat/x', ports: [20000, 20009], envFile: join(laneDir, '.laines.env') });
    const paths = b.readFirst.map((r) => r.path);
    expect(paths).toContain(join(laneDir, 'CLAUDE.md'));
    expect(paths).toContain(join(laneDir, '.ai', 'context'));
    expect(paths).toContain(join(container, '.ai', 'knowledge'));
    expect(paths).not.toContain(join(laneDir, 'AGENTS.md'));
    expect(b.rules.join('\n')).toContain('20000–20009');
    expect(b.rules.join('\n')).toContain('laines report lane_1');
    expect(b.board).toContain('<!-- lane:lane_1:start -->');
    expect(b.text).toContain('# Lane brief: lane_1 (my-app/lane_1)');
  });

  it('runs by name or from inside the lane, and refuses unknown or closed lanes', async () => {
    const { deps, container, laneDir } = await withLane();
    expect((await runBrief({ lane: 'lane_1', container }, deps)).lane).toBe('lane_1');
    expect((await runBrief({}, { ...deps, cwd: () => join(laneDir, '.ai') })).lane).toBe('lane_1');
    await expect(runBrief({ lane: 'nope', container }, deps)).rejects.toBeInstanceOf(InvalidInputError);
    const closed = await withLane({ state: 'closed', closed: '2026-09-29T13:00:00.000Z' });
    await expect(runBrief({ lane: 'lane_1', container: closed.container }, closed.deps)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('prints the text with --format table', async () => {
    const { deps, container } = await withLane();
    const r = await runCli(['brief', 'lane_1', '--container', container, '--format', 'table'], deps);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('# Lane brief: lane_1');
  });
});
