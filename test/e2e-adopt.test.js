import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { invoke } from '../src/commands/registry.js';
import { runDotAi } from '../src/lib/dotai.js';
import { tmp, cleanupTmp, testDeps, gitIn, makeProject } from './helpers.js';

afterEach(cleanupTmp);

describe('adopt → lanes → knowledge through a PR', () => {
  it('moves knowledge from the container into a PR and back to another lane without conflicts', async () => {
    const root = tmp();
    mkdirSync(join(root, 'home'));
    const deps = testDeps(root, { runDotAi });
    const { dir } = makeProject(root, { files: { 'README.md': '# app\n', '.ai/knowledge/a.md': 'A\n' } });
    const c = { container: dir };
    await invoke('adopt', { dir }, deps);
    const two = await invoke('create', c, deps);
    await invoke('ai sync', { lane: 'lane_1', ...c }, deps);
    await invoke('ai sync', { lane: 'lane_2', ...c }, deps);
    writeFileSync(join(dir, '.ai', 'knowledge', 'b.md'), 'learned in lane_2\n');

    const r = await invoke('ai sync', { lane: 'lane_2', ...c }, deps);
    expect(r.toLane).toContain('knowledge/b.md');
    expect(gitIn(two.path, 'status', '--porcelain')).toContain('.ai/knowledge/b.md');
    // Only the new knowledge: lane_1 still holds the scaffold files untracked, which a pull would refuse to overwrite.
    gitIn(two.path, 'add', '.ai/knowledge/b.md');
    gitIn(two.path, 'commit', '-q', '-m', 'knowledge: b');
    gitIn(two.path, 'push', '-q', 'origin', 'HEAD:main');

    const one = join(dir, 'lane_1');
    gitIn(one, 'pull', '-q', '--rebase', 'origin', 'main');
    const back = await invoke('ai sync', { lane: 'lane_1', ...c }, deps);
    expect(back.conflicts).toEqual([]);
    expect(readFileSync(join(one, '.ai', 'knowledge', 'b.md'), 'utf8')).toBe('learned in lane_2\n');
    const doctor = await invoke('doctor', c, deps);
    expect(doctor.checks.find((x) => x.name === 'lane:lane_1').detail).toBe('ok');
  });
});
