import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  findRepoRoot, detectLane, containerDirFrom, loadContainer, laneFrom,
} from '../src/lib/container.js';
import { InvalidInputError, MalformedConfigError, NotAContainerError } from '../src/lib/errors.js';
import { tmp, cleanupTmp, testDeps, setupContainer } from './helpers.js';

afterEach(cleanupTmp);

function fakeContainer(root, id = 'app') {
  const c = join(root, 'c');
  mkdirSync(join(c, '.laines'), { recursive: true });
  writeFileSync(join(c, '.laines', 'container.json'), JSON.stringify({ id }));
  return c;
}

function fakeLane(container, name, markerOverrides = {}) {
  const lane = join(container, name);
  mkdirSync(join(lane, '.git'), { recursive: true });
  mkdirSync(join(lane, '.ai'), { recursive: true });
  mkdirSync(join(lane, 'src', 'deep'), { recursive: true });
  writeFileSync(
    join(lane, '.ai', '.lane.json'),
    JSON.stringify({ lane: name, number: 1, containerId: 'app', container, ...markerOverrides }),
  );
  return lane;
}

describe('lane detection', () => {
  it('finds the repo root and the lane from anywhere inside it', () => {
    const c = fakeContainer(tmp());
    const lane = fakeLane(c, 'lane_1');
    expect(findRepoRoot(join(lane, 'src', 'deep'))).toBe(lane);
    expect(detectLane(join(lane, 'src', 'deep'))).toEqual({ lane: 'lane_1', number: 1, containerId: 'app', container: c, root: lane });
  });

  it('is not a lane without a marker, with a mismatched id, or with a missing container', () => {
    const root = tmp();
    const c = fakeContainer(root);
    mkdirSync(join(root, 'plain', '.git'), { recursive: true });
    expect(detectLane(join(root, 'plain'))).toBeNull();
    expect(detectLane(fakeLane(c, 'lane_2', { containerId: 'other' }))).toBeNull();
    expect(detectLane(fakeLane(c, 'lane_3', { container: join(root, 'gone') }))).toBeNull();
    expect(findRepoRoot(tmp())).toBeNull();
  });
});

describe('containerDirFrom', () => {
  it('resolves --container, the cwd container, or the lane container', () => {
    const root = tmp();
    const c = fakeContainer(root);
    const lane = fakeLane(c, 'lane_1');
    expect(containerDirFrom({ container: 'c' }, testDeps(root))).toBe(c);
    const noCwd = testDeps(root, { cwd: () => { throw new Error('cwd must not be read'); } });
    expect(containerDirFrom({ container: c }, noCwd)).toBe(c);
    expect(containerDirFrom({}, testDeps(root, { cwd: () => c }))).toBe(c);
    expect(containerDirFrom({}, testDeps(root, { cwd: () => join(lane, 'src') }))).toBe(c);
    expect(containerDirFrom({}, testDeps(root))).toBe(root);
  });
});

describe('loadContainer and laneFrom', () => {
  it('loads a real container, from the container or from inside a lane dir', async () => {
    const { deps, container } = await setupContainer();
    const ctx = loadContainer({ container }, deps);
    expect(ctx.root).toBe(container);
    expect(ctx.id).toBe('my-app');
    expect(ctx.portRange).toEqual([20000, 20199]);
    expect(ctx.config.lanePrefix).toBe('lane_');
    expect(ctx.paths.board).toBe(join(container, '.ai', 'context', 'LANES_BOARD.md'));
  });

  it('refuses a non-container and an unregistered container', async () => {
    const { root, deps, container } = await setupContainer();
    expect(() => loadContainer({ container: root }, deps)).toThrow(NotAContainerError);
    writeFileSync(join(deps.env.LAINES_CONFIG_DIR, 'containers.json'), JSON.stringify({ version: 1, machine: { range: [20000, 29999], blockSize: 200 }, containers: [] }));
    expect(() => loadContainer({ container }, deps)).toThrow(MalformedConfigError);
  });

  it('laneFrom uses the name, else the lane the cwd is in', () => {
    const c = fakeContainer(tmp());
    const lane = fakeLane(c, 'lane_1');
    expect(laneFrom({ lane: 'x' }, testDeps(c))).toBe('x');
    expect(laneFrom({}, testDeps(c, { cwd: () => lane }))).toBe('lane_1');
    expect(() => laneFrom({}, testDeps(c))).toThrow(InvalidInputError);
  });
});
