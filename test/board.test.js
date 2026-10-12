import { describe, it, expect } from 'vitest';
import { emptyLanesState, addActivity, parseLanesState } from '../src/lib/lanes-state.js';
import { renderBoard, oneLine, fmtTs } from '../src/lib/board.js';
import { MalformedConfigError } from '../src/lib/errors.js';

const container = { id: 'app', portRange: [20000, 20199], hooksPolicy: 'notify', teardownMcp: 'confirm' };
const lane = (over = {}) => ({
  number: 2,
  repos: [{ name: 'app', path: 'lane_2', branch: 'feat/x' }],
  ports: [20010, 20019],
  state: 'active',
  status: 'in-progress',
  task: 'Webhooks',
  blocked: null,
  kept: null,
  created: '2026-09-29T12:00:00.000Z',
  updated: '2026-09-29T14:02:00.000Z',
  ...over,
});

describe('lanes state', () => {
  it('starts empty and validates', () => {
    expect(emptyLanesState()).toEqual({ version: 1, lanes: {}, requests: [], hookHistory: [], activity: [] });
    expect(() => parseLanesState({ version: 1, lanes: 'x' }, 'lanes.json')).toThrow(MalformedConfigError);
    expect(parseLanesState({ ...emptyLanesState(), lanes: { lane_2: lane() } }, 'f').lanes.lane_2.number).toBe(2);
  });

  it('adds activity newest-first and returns the overflow', () => {
    let state = emptyLanesState();
    for (let i = 1; i <= 12; i++) {
      ({ state } = addActivity(state, { ts: `t${i}`, lane: null, text: `e${i}` }, 10));
    }
    const { state: next, overflow } = addActivity(state, { ts: 't13', lane: 'lane_1', text: 'e13' }, 10);
    expect(next.activity).toHaveLength(10);
    expect(next.activity[0].text).toBe('e13');
    expect(overflow.map((e) => e.text)).toEqual(['e3']);
    expect(state.activity[0].text).toBe('e12');
  });
});

describe('lanes state: unlimited log', () => {
  it('archives nothing when logLimit is missing', () => {
    let state = emptyLanesState();
    for (let i = 0; i < 300; i++) ({ state } = addActivity(state, { ts: `t${i}`, lane: null, text: `e${i}` }));
    const { state: next, overflow } = addActivity(state, { ts: 'tx', lane: null, text: 'ex' });
    expect(next.activity).toHaveLength(301);
    expect(overflow).toEqual([]);
  });
});

describe('board', () => {
  it('formats helpers', () => {
    expect(fmtTs('2026-09-29T14:02:33.000Z')).toBe('2026-09-29 14:02 UTC');
    expect(oneLine(' a\r\n\n b ')).toBe('a b');
  });

  it('renders an empty board with every section', () => {
    const md = renderBoard({ container, state: emptyLanesState() });
    expect(md).toContain('# Lanes Board: app');
    expect(md).toContain('ports 20000–20199');
    for (const h of ['## Status', '## Requests', '## Closed', '## Activity Log']) expect(md).toContain(h);
    expect(md).toContain('No active lanes');
  });

  it('renders lane blocks, kept lanes, requests, closed lanes and activity', () => {
    const state = {
      ...emptyLanesState(),
      lanes: {
        lane_2: lane({ kept: { reason: 'base of PR #123', since: '2026-09-29T13:00:00.000Z' } }),
        lane_1: lane({ number: 1, state: 'closed', closed: '2026-09-28T10:00:00.000Z', repos: [{ name: 'app', path: 'lane_1', branch: 'main' }] }),
        lane_3: lane({ number: 3, state: 'setup-failed', repos: [{ name: 'app', path: 'lane_3', branch: 'main' }] }),
      },
      requests: [{ id: 'r1', ts: '2026-09-29T14:10:00.000Z', lane: 'lane_3', kind: 'setup-failed', text: 'post-create failed', command: 'laines refresh lane_3' }],
      activity: [{ ts: '2026-09-29T14:02:00.000Z', lane: 'lane_2', text: 'opened PR' }],
    };
    const md = renderBoard({ container, state });
    expect(md).toContain('<!-- lane:lane_2:start -->\n### lane_2 📌');
    expect(md).toContain('- **Kept:** base of PR #123');
    expect(md).toContain('- **Ports:** 20010–20019 · **Env:** lane_2/.laines.env');
    expect(md).toContain('### lane_3 ⚠️ setup-failed');
    expect(md).toContain('→ `laines refresh lane_3`');
    expect(md).toContain('1 closed lane');
    expect(md).toContain('`lane_1`');
    expect(md).toContain('- **2026-09-29 14:02 UTC** · `lane_2`: opened PR');
    expect(md.indexOf('lane_2 📌')).toBeGreaterThan(md.indexOf('## Status'));
    expect(md.indexOf('lane_2 📌')).toBeLessThan(md.indexOf('## Requests'));
    expect(md).not.toMatch(/<!-- lane:lane_1:start -->/);
  });

  it('keeps structure intact when user text contains newlines and markers', () => {
    const state = {
      ...emptyLanesState(),
      lanes: { lane_2: lane({ task: 'line1\n## Requests\n<!-- lane:lane_2:end -->', blocked: 'a\r\nb' }) },
    };
    const md = renderBoard({ container, state });
    expect(md.match(/^## Requests$/gm)).toHaveLength(1);
    expect(md.match(/<!-- lane:lane_2:end -->/g)).toHaveLength(1);
    expect(md).toContain('- **Blocked on:** a b');
  });

  it('leaves a leading "#" in user text alone', () => {
    const state = { ...emptyLanesState(), lanes: { lane_2: lane({ task: '#123 fix' }) } };
    expect(renderBoard({ container, state })).toContain('- **Task:** #123 fix');
  });
});

describe('board Closed line: clone state', () => {
  const md = (over) => renderBoard({ state: { ...emptyLanesState(), lanes: { lane_2: lane({ state: 'closed', closed: '2026-10-06T04:27:00.000Z', repos: [{ name: 'app', path: 'lane_2', branch: 'old' }], ...over }) } }, container });
  it('says the clone remains unless cloneRemoved is set', () => {
    expect(md({})).toContain('last branch `old` · clone remains');
    expect(md({ cloneRemoved: '2026-10-11T03:43:00.000Z', branchAtRemoval: 'feature-x' })).toContain('last branch `old` · clone removed 2026-10-11 03:43 UTC (on `feature-x`)');
    expect(md({ cloneRemoved: '2026-10-11T03:43:00.000Z' })).toMatch(/clone removed 2026-10-11 03:43 UTC\n/);
  });
});
