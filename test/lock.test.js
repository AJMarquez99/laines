import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { withLock } from '../src/lib/lock.js';
import { LockTimeoutError } from '../src/lib/errors.js';
import { tmp, cleanupTmp } from './helpers.js';

afterEach(cleanupTmp);

describe('withLock', () => {
  it('holds the lock during fn and releases it after, creating parent dirs', async () => {
    const lock = join(tmp(), 'deep', 'nested', '.lock');
    const seen = await withLock(lock, async () => existsSync(lock));
    expect(seen).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it('releases the lock when fn throws', async () => {
    const lock = join(tmp(), '.lock');
    await expect(withLock(lock, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(existsSync(lock)).toBe(false);
  });

  it('times out with LockTimeoutError when the lock is held, leaving it in place', async () => {
    const lock = join(tmp(), '.lock');
    mkdirSync(lock);
    const noSleep = async () => {};
    await expect(withLock(lock, async () => 1, { timeoutMs: 300, intervalMs: 100, sleep: noSleep }))
      .rejects.toBeInstanceOf(LockTimeoutError);
    expect(existsSync(lock)).toBe(true);
  });

  it('serialises concurrent holders', async () => {
    const lock = join(tmp(), '.lock');
    const order = [];
    const job = (n) => withLock(lock, async () => {
      order.push(`start${n}`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`end${n}`);
    }, { intervalMs: 5 });
    await Promise.all([job(1), job(2), job(3)]);
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i].replace('start', '')).toBe(order[i + 1].replace('end', ''));
    }
  });
});
