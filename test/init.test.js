import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit, parseAgents } from '../src/commands/init.js';
import { runDotAi } from '../src/lib/dotai.js';
import { loadIndex } from '../src/lib/machine-index.js';
import { loadConfig } from '../src/config.js';
import { denyRules, LANES_BEGIN } from '../src/lib/agent-files.js';
import { InvalidInputError, LainesError } from '../src/lib/errors.js';
import { tmp, cleanupTmp, testDeps } from './helpers.js';

afterEach(cleanupTmp);
const REMOTE = 'git@example.com:org/my-app.git';

function setup(overrides) {
  const root = tmp();
  mkdirSync(join(root, 'home'));
  return { root, deps: testDeps(root, { runDotAi, ...overrides }) };
}

describe('parseAgents', () => {
  it('parses, dedupes and validates', () => {
    expect(parseAgents(undefined)).toEqual(['claude']);
    expect(parseAgents('Claude, codex,claude')).toEqual(['claude', 'codex']);
    expect(() => parseAgents('claude,cursor')).toThrow(InvalidInputError);
  });
});

describe('runInit', () => {
  it('creates a complete container', async () => {
    const { root, deps } = setup();
    const r = await runInit({ dir: 'lanes', remote: REMOTE }, deps);
    const c = join(root, 'lanes');
    expect(r).toMatchObject({ dryRun: false, id: 'my-app', path: c, portRange: [20000, 20199], agents: ['claude'] });
    expect(r.repo).toEqual({ name: 'my-app', remote: REMOTE, defaultBranch: 'main' });
    for (const f of r.files) expect(existsSync(join(c, f)), f).toBe(true);
    expect(JSON.parse(readFileSync(join(c, '.laines', 'container.json'), 'utf8')).id).toBe('my-app');
    expect(loadConfig(join(c, '.laines', 'config.json')).hooks.policy).toBe('notify');
    expect(readFileSync(join(c, 'CLAUDE.md'), 'utf8')).toContain(LANES_BEGIN);
    expect(readFileSync(join(c, 'CLAUDE.md'), 'utf8')).toContain('container `my-app`');
    const settings = JSON.parse(readFileSync(join(c, '.claude', 'settings.json'), 'utf8'));
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(denyRules()));
    expect(readFileSync(join(c, '.ai', 'context', 'LANES_BOARD.md'), 'utf8')).toContain('# Lanes Board: my-app');
    expect(readFileSync(join(c, '.ai', 'runbooks', 'README.md'), 'utf8')).toContain('[lane-management.md](lane-management.md)');
    expect(readFileSync(join(c, '.ai', 'templates', 'README.md'), 'utf8')).toContain('[lane-ai-readme.md](lane-ai-readme.md)');
    expect(readFileSync(join(c, '.ai', 'context', 'README.md'), 'utf8')).toContain('<!-- laines:board-note -->');
    expect(readFileSync(join(c, '.laines', 'audit.jsonl'), 'utf8')).toContain('"action":"init"');
    expect(loadIndex(deps.env.LAINES_CONFIG_DIR).containers).toEqual([
      { id: 'my-app', path: c, portRange: [20000, 20199], created: '2026-09-29T12:00:00.000Z' },
    ]);
    expect(runDotAi(['doctor'], { cwd: c }).status).toBe(0);
  });

  it('wires every requested agent and gives a second container of the same repo its own id and block', async () => {
    const { root, deps } = setup();
    await runInit({ dir: 'a', remote: REMOTE }, deps);
    const r = await runInit({ dir: 'b', remote: REMOTE, agents: 'claude,codex,gemini' }, deps);
    expect(r.id).toBe('my-app-2');
    expect(r.portRange).toEqual([20200, 20399]);
    for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
      expect(readFileSync(join(root, 'b', f), 'utf8')).toContain(LANES_BEGIN);
    }
  });

  it('dry run writes nothing and claims nothing', async () => {
    const { root, deps } = setup();
    const r = await runInit({ dir: 'lanes', remote: REMOTE, dryRun: true }, deps);
    expect(r).toMatchObject({ dryRun: true, id: 'my-app', portRange: [20000, 20199] });
    expect(existsSync(join(root, 'lanes'))).toBe(false);
    expect(loadIndex(deps.env.LAINES_CONFIG_DIR).containers).toEqual([]);
  });

  it('refuses unsafe or occupied targets without touching the index', async () => {
    const { root, deps } = setup();
    mkdirSync(join(root, 'has-ai', '.ai'), { recursive: true });
    mkdirSync(join(root, 'has-laines', '.laines'), { recursive: true });
    writeFileSync(join(root, 'file'), 'x');
    await runInit({ dir: 'parent', remote: REMOTE }, deps);
    const cases = [
      { dir: 'has-ai' },
      { dir: 'has-laines' },
      { dir: 'file' },
      { dir: 'parent/inner' },
      { dir: '/' },
      { dir: join(root, 'home') },
      { dir: 'x', remote: '' },
      { dir: 'x', id: 'Bad Id' },
      { dir: 'x', agents: 'cursor' },
    ];
    for (const c of cases) {
      await expect(runInit({ remote: REMOTE, ...c }, deps), JSON.stringify(c)).rejects.toBeInstanceOf(InvalidInputError);
    }
    expect(loadIndex(deps.env.LAINES_CONFIG_DIR).containers.map((e) => e.id)).toEqual(['my-app']);
    expect(existsSync(join(root, 'x'))).toBe(false);
  });

  it('releases the index claim and names the partial directory when dot-ai fails', async () => {
    const failing = () => ({ status: 1, stdout: '', stderr: 'disk full' });
    const { root, deps } = setup({ runDotAi: failing });
    const err = await runInit({ dir: 'lanes', remote: REMOTE }, deps).catch((e) => e);
    expect(err).toBeInstanceOf(LainesError);
    expect(err.message).toContain('disk full');
    expect(err.message).toContain(join(root, 'lanes'));
    expect(loadIndex(deps.env.LAINES_CONFIG_DIR).containers).toEqual([]);
  });
});
