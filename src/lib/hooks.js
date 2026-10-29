import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { readJson, writeJson } from './jsonfile.js';
import { parseWith } from './schema.js';

export const HOOK_EVENTS = ['post-create', 'pre-teardown', 'post-teardown'];

const eventOf = (rel) => rel.split('/')[0].replace(/\.d$/, '');

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

// Spec §8.2: the main hook, then <event>.d/* in name order. Dotfiles are editor and OS litter.
export function listHooks(hooksDir, event) {
  const out = [];
  if (isFile(join(hooksDir, event))) out.push({ rel: event, event, path: join(hooksDir, event) });
  const dir = join(hooksDir, `${event}.d`);
  if (existsSync(dir) && statSync(dir).isDirectory()) {
    for (const name of readdirSync(dir).filter((n) => !n.startsWith('.')).sort()) {
      const path = join(dir, name);
      if (isFile(path)) out.push({ rel: `${event}.d/${name}`, event, path });
    }
  }
  return out;
}

export const checksum = (content) => `sha256:${createHash('sha256').update(content).digest('hex')}`;

export function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return isFile(path);
  } catch {
    return false;
  }
}

// A text file with no #! line. The kernel refuses to start one (ENOEXEC), but glibc's execvp then
// runs it with /bin/sh, so laines checks before spawning to refuse it the same way everywhere.
// A NUL in the first bytes marks a compiled binary, which the kernel starts itself.
export function lacksShebang(path) {
  const buf = Buffer.alloc(512);
  let fd;
  try {
    fd = openSync(path, 'r');
    const head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0));
    return !(head[0] === 0x23 && head[1] === 0x21) && !head.includes(0);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const LockSchema = z.strictObject({
  version: z.literal(1),
  hooks: z.record(z.string(), z.string().regex(/^sha256:[0-9a-f]{64}$/)),
});

export const readHooksLock = (file) =>
  parseWith(LockSchema, readJson(file, { onMissing: () => ({ version: 1, hooks: {} }) }), file);

export function hookStates(paths, events = HOOK_EVENTS) {
  const lock = readHooksLock(paths.hooksLock);
  const hooks = events.flatMap((e) => listHooks(paths.hooks, e)).map((h) => {
    const sum = checksum(readFileSync(h.path));
    const approved = Object.hasOwn(lock.hooks, h.rel) ? lock.hooks[h.rel] : null;
    return { ...h, checksum: sum, approved, state: approved === null ? 'new' : approved === sum ? 'approved' : 'changed' };
  });
  const present = new Set(hooks.map((h) => h.rel));
  const removed = Object.keys(lock.hooks).filter((rel) => events.includes(eventOf(rel)) && !present.has(rel)).sort();
  return { hooks, removed };
}

export function currentChecksums(paths) {
  return Object.fromEntries(HOOK_EVENTS.flatMap((e) => listHooks(paths.hooks, e)).map((h) => [h.rel, checksum(readFileSync(h.path))]));
}

// Records the current hook set as approved: checksums in hooks.lock.json, plus a copy of each file
// in hooks.approved/ so a later change can be shown as a diff. Each file is read once, so the copy
// and the checksum always describe the same content.
export function approveHooks(paths) {
  const { hooks, removed } = hookStates(paths);
  rmSync(paths.hooksApproved, { recursive: true, force: true });
  const sums = {};
  const approved = hooks.map((h) => {
    const content = readFileSync(h.path);
    const dest = join(paths.hooksApproved, h.rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
    sums[h.rel] = checksum(content);
    return { ...h, checksum: sums[h.rel] };
  });
  writeJson(paths.hooksLock, { version: 1, hooks: sums });
  return { approved, removed };
}

const MAX_DIFF = 20000;

export function hookDiff(deps, paths, hook) {
  const old = join(paths.hooksApproved, hook.rel);
  const from = hook.state === 'changed' && existsSync(old) ? old : '/dev/null';
  const r = deps.git(['diff', '--no-index', '--no-color', '--no-ext-diff', '--', from, hook.path], { cwd: paths.root });
  // Exit 1 means the files differ: the normal case here.
  if (r.error || (r.status !== 0 && r.status !== 1)) return `(diff unavailable: ${(r.stderr || r.error?.message || '').trim()})`;
  return r.stdout.length > MAX_DIFF ? `${r.stdout.slice(0, MAX_DIFF)}\n… (diff truncated)` : r.stdout;
}
