import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { invoke } from '../src/commands/registry.js';
import { runDoctor } from '../src/commands/doctor.js';
import { cleanupTmp, setupContainer } from './helpers.js';

afterEach(cleanupTmp);

const FILES = [
  ['runbooks', 'lane-management.md'],
  ['templates', 'lane-ai-readme.md'],
  ['templates', 'lane-context-readme.md'],
  ['templates', 'lane-plans-readme.md'],
  ['templates', 'lane-local-instructions.md'],
];
const read = (f) => readFileSync(f, 'utf8');

// Lays a fresh container out the way laines wrote it before M4.6: old names, rows in README.md.
function downgrade(container) {
  const ai = join(container, '.ai');
  for (const [dir, name] of FILES) {
    renameSync(join(ai, dir, `_${name}`), join(ai, dir, name));
    const readme = join(ai, dir, 'README.md');
    writeFileSync(readme, `${read(readme).replace(/\n*$/, '\n')}| [${name}](${name}) | old row |\n`);
  }
  for (const dir of ['runbooks', 'templates']) renameSync(join(ai, dir, '_README.md'), join(ai, dir, '_gone.txt'));
}

async function lane1(s) {
  await invoke('create', { container: s.container }, s.deps);
}

describe('laines container files', () => {
  it('a fresh container writes _-prefixed files, indexed only in _README.md', async () => {
    const s = await setupContainer();
    const ai = join(s.container, '.ai');
    for (const [dir, name] of FILES) {
      expect(existsSync(join(ai, dir, `_${name}`)), name).toBe(true);
      expect(existsSync(join(ai, dir, name)), name).toBe(false);
      expect(read(join(ai, dir, 'README.md'))).not.toContain(name);
      expect(read(join(ai, dir, '_README.md'))).toContain(`[_${name}](_${name})`);
    }
    expect(read(join(ai, 'runbooks', '_README.md'))).toMatch(/^# Private index\n\nLocal-only/);
    expect((await runDoctor({ container: s.container }, s.deps)).ok).toBe(true);
  });

  it('refresh migrates an old-layout container, keeps a customised template, and a second refresh is a no-op', async () => {
    const s = await setupContainer();
    await lane1(s);
    downgrade(s.container);
    const ai = join(s.container, '.ai');
    writeFileSync(join(ai, 'templates', 'lane-ai-readme.md'), 'my custom lane readme\n');
    const doctor = await runDoctor({ container: s.container }, s.deps);
    expect(doctor.checks.find((c) => c.name === 'agent-files')).toMatchObject({ ok: false });
    expect(doctor.checks.find((c) => c.name === 'agent-files').detail).toContain('laines refresh');

    const r = await invoke('refresh', { lane: 'lane_1', container: s.container }, s.deps);
    expect(r.migrated).toHaveLength(5);
    for (const [dir, name] of FILES) {
      expect(existsSync(join(ai, dir, name)), name).toBe(false);
      expect(existsSync(join(ai, dir, `_${name}`)), name).toBe(true);
      expect(read(join(ai, dir, 'README.md'))).not.toContain(`(${name})`);
      expect(read(join(ai, dir, '_README.md')).split(`](_${name})`)).toHaveLength(2);
    }
    expect(read(join(ai, 'templates', '_lane-ai-readme.md'))).toBe('my custom lane readme\n');
    expect(read(join(s.container, 'lane_1', '.ai', 'README.md'))).toContain('my custom lane readme');
    expect((await runDoctor({ container: s.container }, s.deps)).ok).toBe(true);

    const before = FILES.map(([d]) => read(join(ai, d, '_README.md')) + read(join(ai, d, 'README.md')));
    const again = await invoke('refresh', { lane: 'lane_1', container: s.container }, s.deps);
    expect(again.migrated).toEqual([]);
    expect(FILES.map(([d]) => read(join(ai, d, '_README.md')) + read(join(ai, d, 'README.md')))).toEqual(before);
  });

  it('never overwrites: with both names present, refresh leaves both and warns; doctor reports it', async () => {
    const s = await setupContainer();
    await lane1(s);
    const rb = join(s.container, '.ai', 'runbooks');
    writeFileSync(join(rb, 'lane-management.md'), 'user old\n');
    writeFileSync(join(rb, '_lane-management.md'), 'user new\n');
    const r = await invoke('refresh', { lane: 'lane_1', container: s.container }, s.deps);
    expect(r.warnings.join('\n')).toMatch(/both runbooks\/lane-management\.md and runbooks\/_lane-management\.md exist: keep one by hand/);
    expect(read(join(rb, 'lane-management.md'))).toBe('user old\n');
    expect(read(join(rb, '_lane-management.md'))).toBe('user new\n');
    const d = (await runDoctor({ container: s.container }, s.deps)).checks.find((c) => c.name === 'agent-files');
    expect(d.ok).toBe(false);
  });

  it('migration leaves a user row in README.md alone', async () => {
    const s = await setupContainer();
    await lane1(s);
    downgrade(s.container);
    const readme = join(s.container, '.ai', 'runbooks', 'README.md');
    writeFileSync(readme, `${read(readme)}| [mine.md](mine.md) | mine |\n`);
    await invoke('refresh', { lane: 'lane_1', container: s.container }, s.deps);
    expect(read(readme)).toContain('| [mine.md](mine.md) | mine |');
  });
});
