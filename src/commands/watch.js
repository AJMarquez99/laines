import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { loadContainer } from '../lib/container.js';
import { InvalidInputError } from '../lib/errors.js';

export function newLines(prev, next) {
  const seen = new Set(prev.split('\n'));
  return next.split('\n').filter((line) => line.trim() && !seen.has(line));
}

const sleep = (ms, signal) =>
  new Promise((done) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      done();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      done();
    };
    signal?.addEventListener('abort', onAbort);
  });

// The board is regenerated wholesale on every write, so "what's new" is a line-set difference.
export async function runWatch(opts, deps, { signal, write, intervalMs } = {}) {
  const file = opts.file ? resolve(deps.cwd(), opts.file) : loadContainer(opts, deps).paths.board;
  if (!existsSync(file)) throw new InvalidInputError(`File not found: ${file}`);
  if (!statSync(file).isFile()) throw new InvalidInputError(`Not a file: ${file}`);
  let ms = intervalMs;
  if (ms === undefined) {
    const seconds = Number(opts.interval ?? 2);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new InvalidInputError('--interval must be a positive number of seconds.');
    ms = seconds * 1000;
  }
  let prev = readFileSync(file, 'utf8');
  let updates = 0;
  write(`Watching ${file} (Ctrl-C to stop)\n`);
  while (!signal?.aborted) {
    await sleep(ms, signal);
    if (signal?.aborted) break;
    let cur;
    try {
      cur = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!cur || cur === prev) continue;
    const lines = newLines(prev, cur);
    prev = cur;
    if (!lines.length) continue;
    updates += 1;
    write(`--- ${deps.now()} ${basename(file)} ---\n${lines.join('\n')}\n\n`);
  }
  return { file, updates };
}
