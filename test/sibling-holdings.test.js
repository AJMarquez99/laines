import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { runCreate } from '../src/commands/create.js';
import { runTeardown } from '../src/commands/teardown.js';
import { loadContainer } from '../src/lib/container.js';
import { updateLanes } from '../src/lib/lanes-store.js';
import { siblingHoldings, unpushedWork } from '../src/lib/lane-git.js';
import { cleanupTmp, setupContainer, gitIn } from './helpers.js';

afterEach(cleanupTmp);

// lane_2 holds two commits on `feature` (also a branch in lane_1) and one on `solo` (only lane_2).
async function twoLanes() {
  const s = await setupContainer();
  const l1 = await runCreate({ container: s.container }, s.deps);
  const l2 = await runCreate({ container: s.container }, s.deps);
  gitIn(l2.path, 'checkout', '-q', '-b', 'feature');
  gitIn(l2.path, 'commit', '-q', '--allow-empty', '-m', 'f1');
  gitIn(l2.path, 'commit', '-q', '--allow-empty', '-m', 'f2');
  gitIn(l2.path, 'checkout', '-q', 'main');
  gitIn(l2.path, 'checkout', '-q', '-b', 'solo');
  gitIn(l2.path, 'commit', '-q', '--allow-empty', '-m', 's1');
  gitIn(l2.path, 'checkout', '-q', 'main');
  gitIn(l1.path, 'fetch', '-q', l2.path, 'feature:x');
  return { ...s, l1: l1.path, l2: l2.path, ctx: loadContainer({ container: s.container }, s.deps) };
}

describe('siblingHoldings', () => {
  it('names the sibling lane and refs holding each unpushed ref, and [] for a ref nobody else has', async () => {
    const s = await twoLanes();
    const work = unpushedWork(s.deps, s.l2);
    const h = siblingHoldings(s.deps, s.ctx, 'lane_2', work.refs);
    expect(h.find((r) => r.ref === 'refs/heads/feature')).toEqual({ ref: 'refs/heads/feature', commits: 2, heldBy: [{ lane: 'lane_1', refs: ['refs/heads/x'] }] });
    expect(h.find((r) => r.ref === 'refs/heads/solo')).toMatchObject({ commits: 1, heldBy: [] });
  });

  it('skips a closed sibling and a sibling whose clone is gone', async () => {
    const s = await twoLanes();
    const work = unpushedWork(s.deps, s.l2);
    await updateLanes(s.ctx, s.deps, (st) => {
      st.lanes.lane_1.state = 'closed';
      return { state: st, result: null, activity: [] };
    });
    expect(siblingHoldings(s.deps, s.ctx, 'lane_2', work.refs).every((r) => r.heldBy.length === 0)).toBe(true);
    await updateLanes(s.ctx, s.deps, (st) => {
      st.lanes.lane_1.state = 'active';
      return { state: st, result: null, activity: [] };
    });
    rmSync(s.l1, { recursive: true, force: true });
    expect(siblingHoldings(s.deps, s.ctx, 'lane_2', work.refs).every((r) => r.heldBy.length === 0)).toBe(true);
  });
});

describe('siblingHoldings tips', () => {
  it('resolves an annotated tag to its commit', async () => {
    const s = await twoLanes();
    gitIn(s.l2, 'tag', '-a', '-m', 'note', 'v-ann', 'feature');
    const h = siblingHoldings(s.deps, s.ctx, 'lane_2', [{ ref: 'refs/tags/v-ann', commits: 2 }]);
    expect(h[0].heldBy).toEqual([{ lane: 'lane_1', refs: ['refs/heads/x'] }]);
  });
});

describe('teardown holdings', () => {
  it('the refusal says where each ref is also held', async () => {
    const s = await twoLanes();
    const err = await runTeardown({ lane: 'lane_2', removeDir: true, container: s.container }, s.deps).catch((e) => e);
    expect(err.message).toContain('  - refs/heads/feature (2 commits): also in lane_1 (refs/heads/x)');
    expect(err.message).toContain('  - refs/heads/solo (1 commits): held by no other lane');
  });

  it('the dry run carries checks.holdings and the refusal text', async () => {
    const s = await twoLanes();
    const r = await runTeardown({ lane: 'lane_2', removeDir: true, dryRun: true, container: s.container }, s.deps);
    expect(r.checks.holdings).toHaveLength(2);
    expect(r.refusal).toContain('also in lane_1');
    expect(r.blocked).toBe(true);
  });
});
