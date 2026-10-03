import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmp, cleanupTmp } from './helpers.js';

// Paths that "vanish" between readdirSync listing them and the walk looking at them (atomic-write
// temp files, editor saves), or whose lstat fails for another reason.
const vanish = new Set();
const broken = new Set();
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal();
  const fail = (p, code) => Object.assign(new Error(`${code}: ${p}`), { code });
  const guard = (fn) => (p, ...rest) => {
    if (vanish.has(String(p))) throw fail(p, 'ENOENT');
    if (broken.has(String(p))) throw fail(p, 'EACCES');
    return fn(p, ...rest);
  };
  return { ...fs, default: fs.default, lstatSync: guard(fs.lstatSync), readdirSync: guard(fs.readdirSync) };
});
const { walk } = await import('../src/lib/ai-tree.js');

afterEach(() => {
  vanish.clear();
  broken.clear();
  cleanupTmp();
});

function put(root, rel, text) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

describe('walk with entries vanishing mid-walk', () => {
  it('skips an entry that vanished and still lists every later folder', () => {
    const ai = join(tmp(), '.ai');
    for (const rel of ['context/LANES_BOARD.md.123.456.tmp', 'context/LANES_BOARD.md', 'knowledge/a.md', 'runbooks/r.md']) put(ai, rel, 'x\n');
    put(ai, 'guidelines/g.md', 'g\n');
    vanish.add(join(ai, 'context', 'LANES_BOARD.md.123.456.tmp'));
    vanish.add(join(ai, 'guidelines')); // a folder removed after its parent was listed
    expect(walk(ai).files).toEqual(['context/LANES_BOARD.md', 'knowledge/a.md', 'runbooks/r.md']);
  });

  it('a missing root is empty, and any other error propagates', () => {
    const root = tmp();
    expect(walk(join(root, 'nope'))).toEqual({ files: [], symlinks: [] });
    const ai = join(root, '.ai');
    put(ai, 'knowledge/a.md', 'x\n');
    broken.add(join(ai, 'knowledge', 'a.md'));
    expect(() => walk(ai)).toThrow(/EACCES/);
  });
});
