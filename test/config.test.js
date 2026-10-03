import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildConfig, loadConfig } from '../src/config.js';
import { MalformedConfigError, NotAContainerError } from '../src/lib/errors.js';
import { tmp, cleanupTmp } from './helpers.js';

afterEach(cleanupTmp);

describe('config', () => {
  it('fills every default', () => {
    const c = buildConfig({ repoName: 'app', remote: 'git@example.com:o/app.git', defaultBranch: 'main', agents: ['claude'] });
    expect(c).toEqual({
      repos: { app: { remote: 'git@example.com:o/app.git', defaultBranch: 'main' } },
      lanePrefix: 'lane_',
      maxLanes: 20,
      ports: { stride: 10 },
      hooks: { policy: 'notify', timeoutSec: 300, stableAfter: 3 },
      teardown: { mcp: 'confirm' },
      capabilities: { create: true, report: true, keep: true, teardown: true },
      agents: ['claude'],
      agentCmd: 'claude',
      board: { logLimit: 200 },
      locked: false,
    });
  });

  it('loads a file, reporting a missing one as not-a-container and bad values as malformed', () => {
    const root = tmp();
    const file = join(root, '.laines', 'config.json');
    expect(() => loadConfig(file)).toThrow(NotAContainerError);
    mkdirSync(join(root, '.laines'));
    writeFileSync(file, JSON.stringify({ repos: { app: { remote: 'x' } }, hooks: { policy: 'yolo' } }));
    expect(() => loadConfig(file)).toThrow(/hooks\.policy/);
    writeFileSync(file, JSON.stringify({ repos: { app: { remote: 'x' } }, typo: 1 }));
    expect(() => loadConfig(file)).toThrow(MalformedConfigError);
    writeFileSync(file, JSON.stringify({ repos: { a: { remote: 'x' }, b: { remote: 'y' } } }));
    expect(() => loadConfig(file)).toThrow(/exactly one repo/);
    writeFileSync(file, JSON.stringify({ repos: { app: { remote: 'x' } } }));
    expect(loadConfig(file).hooks.policy).toBe('notify');
  });

  it('reports a missing config inside an existing container as malformed, not as not-a-container', () => {
    const root = tmp();
    const file = join(root, '.laines', 'config.json');
    mkdirSync(join(root, '.laines'));
    expect(() => loadConfig(file)).toThrow(NotAContainerError);
    writeFileSync(join(root, '.laines', 'container.json'), JSON.stringify({ id: 'app' }));
    const err = (() => { try { loadConfig(file); } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(MalformedConfigError);
    expect(err.message).toContain(file);
    expect(err.message).toContain('missing');
  });

  it('rejects dash-prefixed git arguments', () => {
    const base = { repoName: 'app', remote: 'git@example.com:o/app.git', defaultBranch: 'main', agents: ['claude'] };
    expect(() => buildConfig({ ...base, remote: '--upload-pack=x' })).toThrow(/must not start with "-"/);
    expect(() => buildConfig({ ...base, defaultBranch: '--orphan' })).toThrow(/must not start with "-"/);
  });
});

describe('config get with prototype keys', () => {
  it('treats __proto__ and constructor as unknown keys', async () => {
    const { setupContainer } = await import('./helpers.js');
    const { runConfigGet } = await import('../src/commands/config.js');
    const s = await setupContainer();
    for (const key of ['__proto__', 'constructor', 'hooks.__proto__', 'hooks.toString']) {
      await expect(runConfigGet({ key, container: s.container }, s.deps), key).rejects.toMatchObject({ exitCode: 2 });
    }
  });
});
