import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MalformedConfigError } from './errors.js';

// Single JSON-parse choke point: missing or blank → onMissing(); unparseable → MalformedConfigError (exit 2).
export function readJson(path, { onMissing } = {}) {
  const missing = () => (onMissing ? onMissing() : {});
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return missing();
    throw err;
  }
  if (!raw.trim()) return missing();
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new MalformedConfigError(path, err.message);
  }
}

// Atomic write: a crash mid-write never leaves a truncated file behind.
export function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, path);
}

// Own properties only: `__proto__` or `constructor` in a user-supplied key never reaches Object.prototype.
export function getPath(obj, dotted) {
  let cur = obj;
  for (const key of dotted.split('.')) {
    if (cur == null || typeof cur !== 'object' || !Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}
