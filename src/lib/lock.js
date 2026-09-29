import { mkdirSync, rmdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { LockTimeoutError } from './errors.js';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// mkdir is atomic on macOS and Linux: exactly one caller creates the directory.
export async function withLock(lockDir, fn, { timeoutMs = 5000, intervalMs = 100, sleep = defaultSleep } = {}) {
  const attempts = Math.ceil(timeoutMs / intervalMs);
  mkdirSync(dirname(lockDir), { recursive: true });
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (i >= attempts) throw new LockTimeoutError(lockDir, timeoutMs);
      await sleep(intervalMs);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      rmdirSync(lockDir);
    } catch {}
  }
}
