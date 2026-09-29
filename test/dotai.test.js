import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dotAiBin, runDotAi } from '../src/lib/dotai.js';
import { upsertBlock, LANES_BEGIN } from '../src/lib/agent-files.js';
import { tmp, cleanupTmp } from './helpers.js';

afterEach(cleanupTmp);

describe('bundled dot-ai', () => {
  it('resolves the bundled CLI', () => {
    expect(existsSync(dotAiBin())).toBe(true);
  });

  it('initialises a layer non-interactively in the given cwd', () => {
    const d = tmp();
    const r = runDotAi(['init', '--claude'], { cwd: d });
    expect(r.status).toBe(0);
    expect(existsSync(join(d, '.ai', 'README.md'))).toBe(true);
    expect(readFileSync(join(d, 'CLAUDE.md'), 'utf8')).toContain('<!-- BEGIN .ai-convention -->');
  });

  it('keeps the laines-lanes block through dot-ai sync', () => {
    const d = tmp();
    expect(runDotAi(['init', '--claude'], { cwd: d }).status).toBe(0);
    upsertBlock(join(d, 'CLAUDE.md'), 'lane rules here');
    expect(runDotAi(['sync'], { cwd: d }).status).toBe(0);
    const txt = readFileSync(join(d, 'CLAUDE.md'), 'utf8');
    expect(txt).toContain(LANES_BEGIN);
    expect(txt).toContain('lane rules here');
  });

  it('reports a non-zero status instead of throwing', () => {
    const r = runDotAi(['--definitely-not-a-flag'], { cwd: tmp() });
    expect(r.status).not.toBe(0);
  });
});
