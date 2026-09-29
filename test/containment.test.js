import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertLaneDir, removeLaneDir } from '../src/lib/containment.js';
import { BlockedError } from '../src/lib/errors.js';
import { tmp, cleanupTmp } from './helpers.js';

afterEach(cleanupTmp);

describe('containment', () => {
  it('accepts <root>/<name> and removes it', () => {
    const root = tmp();
    mkdirSync(join(root, 'lane_1', 'x'), { recursive: true });
    expect(assertLaneDir(root, join(root, 'lane_1'), 'lane_1')).toBe(join(root, 'lane_1'));
    expect(removeLaneDir(root, join(root, 'lane_1'), 'lane_1')).toBe(true);
    expect(existsSync(join(root, 'lane_1'))).toBe(false);
    expect(assertLaneDir(root, join(root, 'lane_1'), 'lane_1')).toBeNull();
    expect(removeLaneDir(root, join(root, 'lane_1'), 'lane_1')).toBe(false);
  });

  it('refuses anything else, and never touches a symlink target', () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, 'keep.txt'), 'x');
    symlinkSync(outside, join(root, 'lane_2'));
    mkdirSync(join(root, 'nested', 'lane_3'), { recursive: true });
    const cases = [
      [join(root, 'lane_2'), 'lane_2'],
      [join(root, 'nested', 'lane_3'), 'lane_3'],
      [join(root, 'lane_1'), 'lane_9'],
      [root, 'lane_1'],
      [join(root, '..'), '..'],
    ];
    for (const [dir, name] of cases) {
      expect(() => removeLaneDir(root, dir, name), `${dir} ${name}`).toThrow(BlockedError);
    }
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
  });
});
