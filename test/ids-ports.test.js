import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { configDir, containerPaths } from '../src/lib/paths.js';
import {
  slugify, repoSlugFromRemote, uniqueId, validateId, laneSuffix, composeProject, laneId,
} from '../src/lib/ids.js';
import { DEFAULT_MACHINE, allocateBlock, lanePorts } from '../src/lib/ports.js';
import { InvalidInputError, BlockedError } from '../src/lib/errors.js';

describe('configDir', () => {
  it('prefers LAINES_CONFIG_DIR, then XDG_CONFIG_HOME, then ~/.config', () => {
    expect(configDir({ LAINES_CONFIG_DIR: '/x' }, '/h')).toBe('/x');
    expect(configDir({ XDG_CONFIG_HOME: '/xdg' }, '/h')).toBe(join('/xdg', 'laines'));
    expect(configDir({}, '/h')).toBe(join('/h', '.config', 'laines'));
  });
});

describe('containerPaths', () => {
  it('lays out the container', () => {
    const p = containerPaths('/c');
    expect(p.marker).toBe('/c/.laines/container.json');
    expect(p.board).toBe('/c/.ai/context/LANES_BOARD.md');
    expect(p.claudeSettings).toBe('/c/.claude/settings.json');
    expect(p.lock).toBe('/c/.laines/.lock');
  });
});

describe('ids', () => {
  it('slugifies repo names from any remote form', () => {
    expect(repoSlugFromRemote('git@example.com:org/My.Repo.git')).toBe('my-repo');
    expect(repoSlugFromRemote('https://example.com/org/api/')).toBe('api');
    expect(repoSlugFromRemote('/tmp/fixtures/bare.git')).toBe('bare');
    expect(slugify('!!!')).toBe('container');
  });

  it('picks the next free id', () => {
    expect(uniqueId('app', [])).toBe('app');
    expect(uniqueId('app', ['app', 'app-2'])).toBe('app-3');
  });

  it('validates explicit ids', () => {
    expect(validateId('my-app2')).toBe('my-app2');
    expect(() => validateId('My App')).toThrow(InvalidInputError);
    expect(() => validateId('-x')).toThrow(InvalidInputError);
    expect(() => validateId('a'.repeat(33))).toThrow(InvalidInputError);
  });

  it('scopes per-lane names, with an identifier-safe suffix even for hyphenated ids', () => {
    expect(laneSuffix('my-app', 2)).toBe('_my_app_l2');
    expect(laneSuffix('my-app', 2)).toMatch(/^[a-z0-9_]+$/);
    expect(composeProject('my-app', 2)).toBe('my-app-l2');
    expect(laneId('my-app', 'lane_2')).toBe('my-app/lane_2');
  });
});

describe('ports', () => {
  it('allocates the first non-overlapping block', () => {
    expect(allocateBlock(DEFAULT_MACHINE, [])).toEqual([20000, 20199]);
    expect(allocateBlock(DEFAULT_MACHINE, [[20000, 20199]])).toEqual([20200, 20399]);
    expect(allocateBlock(DEFAULT_MACHINE, [[20200, 20399]])).toEqual([20000, 20199]);
    expect(allocateBlock(DEFAULT_MACHINE, [[20150, 20250]])).toEqual([20400, 20599]);
  });

  it('throws BlockedError when the range is full', () => {
    expect(() => allocateBlock({ range: [100, 299], blockSize: 100 }, [[100, 199], [200, 299]])).toThrow(BlockedError);
  });

  it('gives lane N its slice of the block, 1-based', () => {
    expect(lanePorts([20000, 20199], 1, 10)).toEqual([20000, 20009]);
    expect(lanePorts([20000, 20199], 20, 10)).toEqual([20190, 20199]);
    expect(() => lanePorts([20000, 20199], 21, 10)).toThrow(InvalidInputError);
    expect(() => lanePorts([20000, 20199], 0, 10)).toThrow(InvalidInputError);
  });
});
