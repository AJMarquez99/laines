import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newLines, runWatch } from '../src/commands/watch.js';
import { InvalidInputError } from '../src/lib/errors.js';
import { tmp, cleanupTmp, testDeps } from './helpers.js';

afterEach(cleanupTmp);

describe('watch', () => {
  it('finds new lines only', () => {
    expect(newLines('a\nb\n', 'b\na\nc\n\n')).toEqual(['c']);
    expect(newLines('a\n', 'a\n')).toEqual([]);
  });

  it('prints new lines as the file changes and stops on abort', async () => {
    const root = tmp();
    const file = join(root, 'board.md');
    writeFileSync(file, '# board\n');
    const out = [];
    const ac = new AbortController();
    const done = runWatch({ file }, testDeps(root), { signal: ac.signal, write: (s) => out.push(s), intervalMs: 20 });
    await new Promise((r) => setTimeout(r, 60));
    writeFileSync(file, '# board\n- lane_1: started\n');
    await new Promise((r) => setTimeout(r, 120));
    ac.abort();
    const r = await done;
    expect(r).toEqual({ file, updates: 1 });
    expect(out.join('')).toContain('- lane_1: started');
    expect(out.join('')).toContain('board.md');
  });

  it('refuses a missing file and a bad interval', async () => {
    const root = tmp();
    const deps = testDeps(root);
    const ac = new AbortController();
    await expect(runWatch({ file: 'nope.md' }, deps, { signal: ac.signal, write: () => {} })).rejects.toBeInstanceOf(InvalidInputError);
    writeFileSync(join(root, 'f.md'), 'x');
    await expect(runWatch({ file: 'f.md', interval: '0' }, deps, { signal: ac.signal, write: () => {} })).rejects.toBeInstanceOf(InvalidInputError);
  });
});
