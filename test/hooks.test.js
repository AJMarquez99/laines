import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { approveHooks, checksum, currentChecksums, hookDiff, hookStates, isExecutable, listHooks, readHooksLock } from '../src/lib/hooks.js';
import { containerPaths } from '../src/lib/paths.js';
import { MalformedConfigError } from '../src/lib/errors.js';
import { tmp, cleanupTmp, testDeps, writeHook } from './helpers.js';

afterEach(cleanupTmp);

function setup() {
  const root = tmp();
  const paths = containerPaths(root);
  mkdirSync(paths.hooks, { recursive: true });
  writeFileSync(join(paths.hooks, 'README.md'), '# Hooks\n');
  writeFileSync(paths.hooksLock, JSON.stringify({ version: 1, hooks: {} }));
  return { root, paths, deps: testDeps(root) };
}

describe('listHooks', () => {
  it('lists the main hook, then <event>.d/ entries in name order, skipping dotfiles, directories and other files', () => {
    const { root, paths } = setup();
    writeHook(root, 'post-create.d/20-b', 'true');
    writeHook(root, 'post-create.d/10-a', 'true');
    writeHook(root, 'post-create.d/.10-a.swp', 'true');
    mkdirSync(join(paths.hooks, 'post-create.d', '30-dir'));
    writeHook(root, 'post-create', 'true');
    writeHook(root, 'pre-teardown', 'true');
    expect(listHooks(paths.hooks, 'post-create').map((h) => h.rel)).toEqual(['post-create', 'post-create.d/10-a', 'post-create.d/20-b']);
    expect(listHooks(paths.hooks, 'post-create')[0]).toEqual({ rel: 'post-create', event: 'post-create', path: join(paths.hooks, 'post-create') });
    expect(listHooks(paths.hooks, 'post-teardown')).toEqual([]);
    expect(listHooks(join(root, 'nope'), 'post-create')).toEqual([]);
  });
});

describe('checksum and executable bit', () => {
  it('hashes content and reads the executable bit', () => {
    const { root } = setup();
    expect(checksum('abc')).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(isExecutable(writeHook(root, 'post-create', 'true'))).toBe(true);
    expect(isExecutable(writeHook(root, 'pre-teardown', 'true', { mode: 0o644 }))).toBe(false);
    expect(isExecutable(join(root, 'missing'))).toBe(false);
  });
});

describe('hookStates and approveHooks', () => {
  it('classifies hooks as new, approved or changed, and lists approved hooks that were removed', () => {
    const { root, paths } = setup();
    writeHook(root, 'post-create', 'echo one');
    writeHook(root, 'pre-teardown', 'echo keep');
    expect(hookStates(paths).hooks.map((h) => [h.rel, h.state, h.approved])).toEqual([['post-create', 'new', null], ['pre-teardown', 'new', null]]);

    const first = approveHooks(paths);
    expect(first.approved.map((h) => [h.rel, h.state])).toEqual([['post-create', 'new'], ['pre-teardown', 'new']]);
    expect(hookStates(paths).hooks.every((h) => h.state === 'approved')).toBe(true);

    writeHook(root, 'post-create', 'echo two');
    writeHook(root, 'post-teardown', 'echo new');
    rmSync(join(paths.hooks, 'pre-teardown'));
    const s = hookStates(paths);
    expect(s.hooks.map((h) => [h.rel, h.state])).toEqual([['post-create', 'changed'], ['post-teardown', 'new']]);
    expect(s.removed).toEqual(['pre-teardown']);
    expect(hookStates(paths, ['post-create']).removed).toEqual([]);
  });

  it('writes checksums to hooks.lock.json and approved copies to hooks.approved/, dropping removed hooks', () => {
    const { root, paths } = setup();
    writeHook(root, 'post-create.d/10-db', 'echo db');
    writeHook(root, 'pre-teardown', 'echo bye');
    approveHooks(paths);
    rmSync(join(paths.hooks, 'pre-teardown'));
    const r = approveHooks(paths);
    expect(r.removed).toEqual(['pre-teardown']);
    const lock = readHooksLock(paths.hooksLock);
    expect(Object.keys(lock.hooks)).toEqual(['post-create.d/10-db']);
    expect(lock.hooks['post-create.d/10-db']).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(readFileSync(join(paths.hooksApproved, 'post-create.d', '10-db'), 'utf8')).toBe('#!/bin/sh\necho db\n');
    expect(existsSync(join(paths.hooksApproved, 'pre-teardown'))).toBe(false);
    expect(currentChecksums(paths)).toEqual(lock.hooks);
  });

  it('rejects a malformed hooks.lock.json', () => {
    const { paths } = setup();
    writeFileSync(paths.hooksLock, '{');
    expect(() => hookStates(paths)).toThrow(MalformedConfigError);
    writeFileSync(paths.hooksLock, JSON.stringify({ version: 1, hooks: { 'post-create': 42 } }));
    expect(() => hookStates(paths)).toThrow(MalformedConfigError);
  });
});

describe('hookDiff', () => {
  it('diffs a changed hook against its approved copy, and a new hook against nothing', () => {
    const { root, paths, deps } = setup();
    writeHook(root, 'post-create', 'echo one');
    approveHooks(paths);
    writeHook(root, 'post-create', 'echo two');
    writeHook(root, 'pre-teardown', 'echo fresh');
    const [changed, fresh] = hookStates(paths).hooks;
    const d1 = hookDiff(deps, paths, changed);
    expect(d1).toContain('-echo one');
    expect(d1).toContain('+echo two');
    expect(hookDiff(deps, paths, fresh)).toContain('+echo fresh');
  });
});
