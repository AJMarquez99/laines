import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBrief } from '../src/commands/brief.js';
import { runCreate } from '../src/commands/create.js';
import { runReport, runKeep, runRelease, runStatus, runList } from '../src/commands/lanes.js';
import { runTeardown } from '../src/commands/teardown.js';
import { InvalidInputError } from '../src/lib/errors.js';
import { cleanupTmp, setupContainer } from './helpers.js';

afterEach(cleanupTmp);

const KEYS = ['constructor', '__proto__', 'toString', 'hasOwnProperty'];

describe('lane names that are Object.prototype keys', () => {
  it('are unknown lanes to every lookup, and nothing is written', async () => {
    const { deps, container } = await setupContainer();
    const lanesFile = join(container, '.laines', 'lanes.json');
    const boardFile = join(container, '.ai', 'context', 'LANES_BOARD.md');
    const before = [readFileSync(lanesFile, 'utf8'), readFileSync(boardFile, 'utf8')];
    for (const lane of KEYS) {
      const calls = {
        brief: () => runBrief({ lane, container }, deps),
        report: () => runReport({ lane, status: 'x', container }, deps),
        keep: () => runKeep({ lane, reason: 'x', container }, deps),
        release: () => runRelease({ lane, container }, deps),
        status: () => runStatus({ lane, container }, deps),
        teardown: () => runTeardown({ lane, removeDir: true, force: true, container }, deps),
      };
      for (const [cmd, call] of Object.entries(calls)) {
        const err = await call().catch((e) => e);
        expect(err, `${cmd} ${lane}`).toBeInstanceOf(InvalidInputError);
        expect(err.exitCode).toBe(2);
      }
    }
    expect([readFileSync(lanesFile, 'utf8'), readFileSync(boardFile, 'utf8')]).toEqual(before);
    expect(Object.prototype.status).toBeUndefined();
    expect({}.updated).toBeUndefined();
  });

  it('create refuses __proto__ and makes a real lane named constructor', async () => {
    const { deps, container } = await setupContainer();
    await expect(runCreate({ name: '__proto__', container }, deps)).rejects.toBeInstanceOf(InvalidInputError);
    const r = await runCreate({ name: 'constructor', container }, deps);
    expect(r).toMatchObject({ lane: 'constructor', number: 1 });
    const list = await runList({ container }, deps);
    expect(list.lanes.map((l) => l.lane)).toEqual(['constructor']);
    expect(await runBrief({ lane: 'constructor', container }, deps)).toMatchObject({ lane: 'constructor' });
  });
});
