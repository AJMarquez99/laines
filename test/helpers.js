import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made = [];

export function tmp(prefix = 'laines-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

export function cleanupTmp() {
  while (made.length) rmSync(made.pop(), { recursive: true, force: true });
}

// Deps rooted in a temp dir: the machine index never touches the real ~/.config.
export function testDeps(root, overrides = {}) {
  return {
    env: { LAINES_CONFIG_DIR: join(root, 'config') },
    homedir: () => join(root, 'home'),
    cwd: () => root,
    now: () => '2026-09-29T12:00:00.000Z',
    runDotAi: () => {
      throw new Error('runDotAi not stubbed in this test');
    },
    warn: () => {},
    ...overrides,
  };
}
