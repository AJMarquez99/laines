import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  const marker = join(container, '.laines', 'container.json');
  const m = JSON.parse(read(marker));
  delete m.layout;
  writeFileSync(marker, JSON.stringify(m));
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
    const marker = join(s.container, '.laines', 'container.json');
    writeFileSync(marker, JSON.stringify({ ...JSON.parse(read(marker)), layout: undefined }));
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

  it('stamps layout 2 on a fresh container and on a migrated one', async () => {
    const s = await setupContainer();
    const marker = join(s.container, '.laines', 'container.json');
    expect(JSON.parse(read(marker)).layout).toBe(2);
    await lane1(s);
    downgrade(s.container);
    expect(JSON.parse(read(marker)).layout).toBeUndefined();
    const dry = await invoke('refresh', { lane: 'lane_1', container: s.container, dryRun: true }, s.deps);
    expect(dry.wouldMigrate).toHaveLength(5);
    expect(existsSync(join(s.container, '.ai', 'runbooks', 'lane-management.md'))).toBe(true);
    expect(JSON.parse(read(marker)).layout).toBeUndefined();
    await invoke('refresh', { lane: 'lane_1', container: s.container }, s.deps);
    expect(JSON.parse(read(marker))).toMatchObject({ layout: 2, id: 'my-app' });
  });

  it('pre-M4.6 with both names present: warns, does not stamp, and completes once the user removes one', async () => {
    const s = await setupContainer();
    await lane1(s);
    downgrade(s.container);
    const rb = join(s.container, '.ai', 'runbooks');
    writeFileSync(join(rb, '_lane-management.md'), 'user new\n');
    const marker = join(s.container, '.laines', 'container.json');
    const r = await invoke('refresh', { lane: 'lane_1', container: s.container }, s.deps);
    expect(r.warnings.join('\n')).toContain('keep one by hand');
    expect(JSON.parse(read(marker)).layout).toBeUndefined();
    expect(read(join(rb, '_README.md'))).toContain('(_lane-management.md)');
    const d = (await runDoctor({ container: s.container }, s.deps)).checks.find((c) => c.name === 'agent-files');
    expect(d.detail).toContain('keep one by hand, then run');
    renameSync(join(rb, 'lane-management.md'), join(s.root, 'kept.md'));
    await invoke('refresh', { lane: 'lane_1', container: s.container }, s.deps);
    expect(JSON.parse(read(marker)).layout).toBe(2);
    expect((await runDoctor({ container: s.container }, s.deps)).ok).toBe(true);
  });

  const ownFile = (container) => {
    const rb = join(container, '.ai', 'runbooks');
    expect(read(join(rb, 'lane-management.md'))).toBe('project runbook\n');
    expect(read(join(rb, 'README.md'))).toContain('(lane-management.md)');
  };

  it('layout 2: a project\'s own plain lane-management.md (seeded from the remote) is left alone', async () => {
    const s = await setupContainer({ files: {
      'README.md': '# app\n',
      '.ai/runbooks/lane-management.md': 'project runbook\n',
      '.ai/runbooks/README.md': '# Runbooks\n\n## Index\n\n| File | Answers |\n|---|---|\n| [lane-management.md](lane-management.md) | theirs |\n',
    } });
    await lane1(s);
    ownFile(s.container);
    expect((await runDoctor({ container: s.container }, s.deps)).checks.find((c) => c.name === 'agent-files').ok).toBe(true);
    const r = await invoke('refresh', { lane: 'lane_1', container: s.container }, s.deps);
    expect(r.migrated).toEqual([]);
    expect(r.warnings.join('\n')).not.toContain('keep one by hand');
    ownFile(s.container);
  });

  it('layout 2: a user who deleted the _ file and kept their own plain file keeps it', async () => {
    const s = await setupContainer();
    await lane1(s);
    const rb = join(s.container, '.ai', 'runbooks');
    rmSync(join(rb, '_lane-management.md'));
    writeFileSync(join(rb, 'lane-management.md'), 'project runbook\n');
    writeFileSync(join(rb, 'README.md'), `${read(join(rb, 'README.md'))}| [lane-management.md](lane-management.md) | mine |\n`);
    expect((await runDoctor({ container: s.container }, s.deps)).checks.find((c) => c.name === 'agent-files').ok).toBe(true);
    const r = await invoke('refresh', { lane: 'lane_1', container: s.container }, s.deps);
    expect(r.migrated).toEqual([]);
    ownFile(s.container);
    expect(existsSync(join(rb, '_lane-management.md'))).toBe(false);
  });
  it('pre-M4.6: a README.md row for a laines file absent under both names is removed and the layout stamped', async () => {
    const s = await setupContainer();
    await lane1(s);
    downgrade(s.container);
    const rb = join(s.container, '.ai', 'runbooks');
    rmSync(join(rb, 'lane-management.md'));
    const readme = join(rb, 'README.md');
    expect(read(readme)).toContain('(lane-management.md)');
    const marker = join(s.container, '.laines', 'container.json');
    const dry = await invoke('refresh', { lane: 'lane_1', container: s.container, dryRun: true }, s.deps);
    expect(dry.wouldMigrate).toContain('runbooks/lane-management.md');
    expect(read(readme)).toContain('(lane-management.md)');
    expect(JSON.parse(read(marker)).layout).toBeUndefined();
    const r = await invoke('refresh', { lane: 'lane_1', container: s.container }, s.deps);
    expect(r.migrated).toContain('runbooks/lane-management.md');
    expect(read(readme)).not.toContain('(lane-management.md)');
    expect(existsSync(join(rb, '_lane-management.md'))).toBe(false);
    expect(JSON.parse(read(marker)).layout).toBe(2);
    expect((await runDoctor({ container: s.container }, s.deps)).ok).toBe(true);
  });

  it('layout 2: a lane renders the package template, not a project\'s own plain-named template', async () => {
    const s = await setupContainer();
    const tpl = join(s.container, '.ai', 'templates');
    rmSync(join(tpl, '_lane-ai-readme.md'));
    writeFileSync(join(tpl, 'lane-ai-readme.md'), 'project own template\n');
    await lane1(s);
    const out = read(join(s.container, 'lane_1', '.ai', 'README.md'));
    expect(out).not.toContain('project own template');
    expect(out).toContain('lane_1');
  });
});
