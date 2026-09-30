# L.AI.nes M3 — Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project hooks run at lane lifecycle events under a checksum policy: `post-create` after `create` (and again on the new `refresh`), `pre-teardown` before anything is archived or deleted, `post-teardown` after the lane is closed. A failed `post-create` keeps the lane as `setup-failed` with a board request; `laines hooks status / approve / policy` let a human review, approve and lock hooks; a stable hook set triggers a lock suggestion.

**Architecture:** Four new library modules on top of M2's layering. `hooks.js` knows what hooks exist and whether they are approved (discovery, checksums, `hooks.lock.json`, approved copies in `.laines/hooks.approved/` for diffs). `hook-runner.js` runs one executable (process group, timeout, output cap, signal forwarding) and is wired in as `deps.runHook`. `hook-events.js` runs one event under the policy and turns the result into data (outcome, untrusted output, board entries, typed error); it never touches `lanes.json` itself. Commands (`create`, `refresh`, `teardown`, `hooks *`, `doctor`) call it outside the container lock and record the outcome through `updateLanes`. Board requests become keyed (`<kind>:<lane|*>`) so a repeat replaces instead of piling up.

**Tech Stack:** Node ≥ 20 (ESM), commander 12, zod 4, vitest 4, system `git` (≥ 2.28, also used for `git diff --no-index`), `/bin/sh` for test fixture hooks.

**Spec:** `.ai/plans/2026-09-29-laines-spec.md` — §8 (hooks, contract, policy), §10.2 steps 5–6, §10.3 steps 4 and 7, §11 (Requests), §14 criterion 4. Also read `.ai/notes/m2-carry-overs.md` ("M3" section — every item is placed below) and the M2 plan's Global Constraints (`.ai/plans/2026-09-29-laines-m2-lanes-plan.md`).

**Decisions already made (do not re-litigate):**
- **`.laines.env` on refresh:** regenerated from scratch, then `post-create` re-runs and re-appends whatever it appended before. Hand edits are lost; docs say so. (User's call, 2026-09-29.)
- **Diffs for changed hooks:** approving copies each hook into `.laines/hooks.approved/<rel>`; `hooks status` and a refusal under `approve` diff the current file against that copy with `git diff --no-index`. `hooks.lock.json` keeps `{ version: 1, hooks: { <rel>: "sha256:<hex>" } }`.
- **`refresh [lane]`** takes an implicit lane from inside a lane (like `report`); it is not human-only.
- **`refresh` records the lane's current branch** (the board and `LANE_BRANCH` follow the clone).
- **Tearing down a closed lane again** re-runs a `post-teardown` that failed last time (the `cleanup-incomplete` request's resolving command is `laines teardown <lane>`). The second phase of a two-step teardown runs no other hooks.
- **`lane-local-instructions.md` is overridable** from the container's `.ai/templates/`, like the lane README templates.
- **Known residual (for M5's SECURITY.md):** hooks never run under the container lock, so a `keep` that lands while `pre-teardown` is running aborts the teardown only after the hook's side effects. Teardown re-reads `kept` just before the hook to keep that window short. Task 8 adds this line to the M5 section of `.ai/notes/m2-carry-overs.md`.
- **Carry-over dropped:** "the create-cleanup warning can suggest `teardown` when unregistering succeeded" — when unregistering succeeds the lane no longer exists for `teardown` to find, so the current "remove it by hand" wording is correct. No change.

**Out of scope (M4):** MCP server, capabilities (exit 4), locked mode (`hooks approve`/`hooks policy` will exit 3 when `locked`), `config set`, async git, atomic board writes.

## Global Constraints

- Everything in the M1 and M2 plans' Global Constraints still applies (Node `>=20`, ESM, exit codes `0/1/2/3/4`, JSON default with `--format table`, `--dry-run` is a true no-op, commands return data and never print or set `process.exitCode`, `readJson`/`writeJson` for all JSON, every `lanes.json` change through `updateLanes`, git only through `deps.git`, global options only via `withGlobals` on leaf commands, conventional commits staged by explicit path).
- Hooks run only through `runEvent` → `deps.runHook`. The hook file is executed directly (never through a shell string), with stdin empty (`/dev/null`), the parent `PATH`/env minus `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_NAMESPACE`, in its own process group so a timeout or an interrupt stops everything it started.
- **No hook runs while the container lock is held** (hooks may take minutes; the lock waits 5s). **No hook runs under `--dry-run`.**
- Hook output is returned as `results[].output` with `untrusted: true`, and printed under the label `Hook output (untrusted: printed by the project's hook script):`.
- Board requests are written only through `putRequest` / `dropRequests`; the id is `<kind>:<lane>` or `<kind>:*`. Kinds: `setup-failed`, `teardown-blocked`, `cleanup-incomplete` (per lane), `hooks-changed`, `hooks-lock` (container-wide).
- `hooks approve` and `hooks policy` are human-only (their deny rules already exist from M1) and never gain an implicit target.
- Commit trailer, exactly: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- The user's shell aliases `rm`/`cp` to interactive prompts: in Bash use `command rm -f` / `command cp`, in tests use Node `fs`.

## Review Focus

1. **A `post-create` that starts a dev server in the background (`npm run dev &`) and exits** — `create` must return when the hook exits, not wait for the server or the timeout. Task 2 pins it.
2. **A hook that waits for input or hangs on the network** — stdin is empty so `read` gets EOF at once; a real hang is killed with its children at `hooks.timeoutSec` and the lane is `setup-failed`. Tasks 2 and 3 pin it.
3. **A hook file without the executable bit** (written by an agent, or copied without `chmod`) — a clear `chmod +x` message and a `setup-failed` lane, never a crash; `doctor` flags it. Tasks 3 and 8 pin it.
4. **Ctrl-C during a long `post-create`** — the interrupt reaches the hook's process group, the hook stops, and the lane ends `setup-failed` instead of orphaned processes and a lane stuck `spinning up`. Task 2 pins forwarding through an injected signal source.
5. **`refresh` of a lane whose `post-create` appends to `.laines.env`** — the appended lines appear exactly once after any number of refreshes. Task 5 pins it.

---

## File structure (new and changed in M3)

```
src/lib/paths.js          (chg)  + hooksApproved
src/lib/hooks.js          (new)  HOOK_EVENTS, listHooks, checksum, readHooksLock, hookStates, approveHooks, hookDiff, isExecutable, currentChecksums
src/lib/hook-runner.js    (new)  runHookFile
src/lib/hook-events.js    (new)  runEvent, dryRunHooks, runSummary, hookBoardEntries, hookError, unapprovedWarnings,
                                 setupFailedRequest, setupFailedNext, lockRequest, lockSuggested, HISTORY_CAP, laneHookVars
src/lib/lanes-state.js    (chg)  + requestId, putRequest, dropRequests
src/lib/lane-files.js     (chg)  + laneVars; laneEnv header; lane-local-instructions via container template
src/lib/errors.js         (chg)  + HookError
src/lib/format.js         (chg)  + formatDryHooks, formatRefresh, formatHooksStatus, formatHooksApprove, formatHooksPolicy; create/teardown show hooks
src/config.js             (chg)  + saveConfig
src/deps.js               (chg)  + runHook
src/commands/create.js    (chg)  post-create, setup-failed, hook history, lock suggestion, stricter explicit numbers
src/commands/refresh.js   (new)  runRefresh
src/commands/teardown.js  (chg)  pre-/post-teardown, cleanup retry, phase-2 board line
src/commands/hooks.js     (new)  runHooksStatus, runHooksApprove, runHooksPolicy
src/commands/doctor.js    (chg)  hooks check, setup-failed and stale "spinning up" lanes
src/commands/init.js      (chg)  ship lane-local-instructions.md into .ai/templates/
src/cli.js                (chg)  register refresh, hooks status/approve/policy
templates/hooks-readme.md, templates/lane-management.md (chg)
test/helpers.js           (chg)  + writeHook, setConfig; testDeps gains runHook
test/hooks.test.js, test/hook-runner.test.js, test/hook-events.test.js, test/refresh.test.js, test/hooks-commands.test.js (new)
test/create.test.js, test/teardown.test.js, test/doctor.test.js, test/lanes-store.test.js (chg)
README.md, .ai/plans/2026-09-29-laines-spec.md, .ai/plans/2026-09-29-laines-roadmap.md, .ai/notes/*.md (chg)
```

---

### Task 1: Hook discovery, checksums, approval store

**Files:**
- Create: `src/lib/hooks.js`
- Modify: `src/lib/paths.js`, `test/helpers.js`
- Test: `test/hooks.test.js`

**Interfaces:**
- Consumes: `readJson`, `writeJson` (`src/lib/jsonfile.js`), `parseWith` (`src/lib/schema.js`), `containerPaths` (`src/lib/paths.js`), `deps.git`.
- Produces:
  - `containerPaths(root).hooksApproved` = `<root>/.laines/hooks.approved`
  - `HOOK_EVENTS = ['post-create', 'pre-teardown', 'post-teardown']`
  - `listHooks(hooksDir, event) → Array<{ rel, event, path }>` — `<event>` first, then `<event>.d/*` sorted, dotfiles and directories skipped
  - `checksum(bufferOrString) → 'sha256:<64 hex>'`
  - `readHooksLock(file) → { version: 1, hooks: Record<rel, checksum> }` (missing → empty; malformed → `MalformedConfigError`)
  - `hookStates(paths, events = HOOK_EVENTS) → { hooks: HookInfo[], removed: string[] }`, `HookInfo = { rel, event, path, checksum, approved: string|null, state: 'approved'|'changed'|'new' }`; `removed` = approved rels of those events no longer present
  - `approveHooks(paths) → { approved: HookInfo[] /* state as before approval */, removed: string[] }` — rewrites the lock and `hooks.approved/`
  - `hookDiff(deps, paths, hookInfo) → string` (unified diff; approved copy or `/dev/null` → current)
  - `isExecutable(path) → boolean`
  - `currentChecksums(paths) → Record<rel, checksum>` (all events; reads hook files only, never the lock)
  - test helpers: `writeHook(container, rel, body, { mode = 0o755 } = {}) → path` (writes `#!/bin/sh\n<body>\n` under `<container>/.laines/hooks/<rel>`), `setConfig(container, mutate)` (read-modify-write `.laines/config.json`)

- [ ] **Step 1: Add the test helpers**

In `test/helpers.js`, change the `node:fs` import to:
```js
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
```
and append:
```js
// A fixture hook: a /bin/sh script under <container>/.laines/hooks/<rel>.
export function writeHook(container, rel, body, { mode = 0o755 } = {}) {
  const file = join(container, '.laines', 'hooks', rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, mode);
  return file;
}

export function setConfig(container, mutate) {
  const file = join(container, '.laines', 'config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  mutate(config);
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
}
```

- [ ] **Step 2: Write the failing test**

`test/hooks.test.js`:
```js
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/hooks.test.js`
Expected: FAIL — `Failed to resolve import "../src/lib/hooks.js"`.

- [ ] **Step 4: Implement**

`src/lib/paths.js` — in `containerPaths`, after `hooksLock`:
```js
    hooksApproved: join(laines, 'hooks.approved'),
```

`src/lib/hooks.js`:
```js
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/hooks.test.js` → PASS. Then `npm run test:run` → all pass; `npm run lint` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/hooks.js src/lib/paths.js test/hooks.test.js test/helpers.js
git commit -m "feat: hook discovery, checksums and approval store

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Hook process runner

**Files:**
- Create: `src/lib/hook-runner.js`
- Modify: `src/deps.js`, `test/helpers.js`
- Test: `test/hook-runner.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `runHookFile({ file, cwd, vars, timeoutMs, signals = process }) → Promise<{ status: number|null, signal: string|null, timedOut: boolean, output: string, error: Error|null, durationMs: number }>` — never rejects. `output` is stdout and stderr interleaved, at most 64 KiB (the tail, prefixed `… (output truncated)\n`).
  - `defaultDeps.runHook = (opts) => runHookFile(opts)`; `testDeps` gains `runHook: runHookFile`.

- [ ] **Step 1: Write the failing test**

`test/hook-runner.test.js`:
```js
import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runHookFile } from '../src/lib/hook-runner.js';
import { tmp, cleanupTmp } from './helpers.js';

afterEach(cleanupTmp);

function script(dir, body, name = 'hook') {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

describe('runHookFile', () => {
  it('runs in cwd with the given variables and captures stdout and stderr', async () => {
    const dir = tmp();
    const file = script(dir, 'echo "out $LANE_NAME $(pwd -P)"; echo err >&2');
    const r = await runHookFile({ file, cwd: dir, vars: { LANE_NAME: 'lane_1' }, timeoutMs: 5000 });
    expect(r).toMatchObject({ status: 0, signal: null, timedOut: false, error: null });
    expect(r.output).toContain(`out lane_1 ${dir}`);
    expect(r.output).toContain('err');
  });

  it('returns the exit status', async () => {
    const dir = tmp();
    expect((await runHookFile({ file: script(dir, 'exit 3'), cwd: dir, vars: {}, timeoutMs: 5000 })).status).toBe(3);
  });

  it('keeps PATH but drops variables that would point git at another repository', async () => {
    const dir = tmp();
    const file = script(dir, 'command -v git >/dev/null && echo has-git; echo "gd=${GIT_DIR-unset}"');
    const r = await runHookFile({ file, cwd: dir, vars: { GIT_DIR: '/elsewhere' }, timeoutMs: 5000 });
    expect(r.output).toContain('has-git');
    expect(r.output).toContain('gd=unset');
  });

  it('gives the hook an empty stdin, so a prompt cannot hang it', async () => {
    const dir = tmp();
    const r = await runHookFile({ file: script(dir, 'read answer; echo "read=$?"'), cwd: dir, vars: {}, timeoutMs: 5000 });
    expect(r.output).toContain('read=1');
    expect(r.durationMs).toBeLessThan(2000);
  });

  it('stops the hook and everything it started when it times out', async () => {
    const dir = tmp();
    const file = script(dir, 'sleep 30 &\necho $! > child.pid\nwait');
    const r = await runHookFile({ file, cwd: dir, vars: {}, timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.status).toBe(null);
    const pid = Number(readFileSync(join(dir, 'child.pid'), 'utf8'));
    expect(await until(() => !alive(pid))).toBe(true);
  });

  it('returns once the hook exits, even if a background process keeps its output open', async () => {
    const dir = tmp();
    const started = Date.now();
    const r = await runHookFile({ file: script(dir, 'sleep 3 &\necho done'), cwd: dir, vars: {}, timeoutMs: 10000 });
    expect(r.status).toBe(0);
    expect(r.output).toContain('done');
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('keeps only the tail of very long output', async () => {
    const dir = tmp();
    const body = 'i=0; while [ $i -lt 3000 ]; do echo "line $i ................................................................"; i=$((i+1)); done';
    const r = await runHookFile({ file: script(dir, body), cwd: dir, vars: {}, timeoutMs: 10000 });
    expect(r.output.startsWith('… (output truncated)\n')).toBe(true);
    expect(r.output.length).toBeLessThanOrEqual(64 * 1024 + 30);
    expect(r.output).toContain('line 2999');
  });

  it('reports a file that cannot be run instead of throwing', async () => {
    const dir = tmp();
    const r = await runHookFile({ file: join(dir, 'missing'), cwd: dir, vars: {}, timeoutMs: 5000 });
    expect(r.status).toBe(null);
    expect(r.error).toBeInstanceOf(Error);
  });

  it('passes an interrupt on to the hook, then stops listening', async () => {
    const dir = tmp();
    const signals = new EventEmitter();
    const pending = runHookFile({ file: script(dir, 'sleep 30'), cwd: dir, vars: {}, timeoutMs: 20000, signals });
    await new Promise((r) => setTimeout(r, 200));
    signals.emit('SIGINT');
    const r = await pending;
    expect(r).toMatchObject({ signal: 'SIGTERM', timedOut: false, status: null });
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/hook-runner.test.js`
Expected: FAIL — cannot resolve `../src/lib/hook-runner.js`.

- [ ] **Step 3: Implement**

`src/lib/hook-runner.js`:
```js
import { spawn } from 'node:child_process';

const MAX_OUTPUT = 64 * 1024;
const KILL_GRACE_MS = 5000;
// After the hook exits, how long to wait for its output pipes to close. A process it left running
// in the background (a dev server) may hold them open indefinitely.
const EXIT_GRACE_MS = 1000;
const REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_NAMESPACE'];
const FORWARDED = ['SIGINT', 'SIGTERM'];

// Runs one hook file. Never rejects: every outcome comes back as data.
// The hook leads its own process group, so a timeout or an interrupt stops everything it started.
// While it runs, SIGINT/SIGTERM sent to laines are passed on to that group instead of killing
// laines, so the caller still records the outcome.
export function runHookFile({ file, cwd, vars, timeoutMs, signals = process }) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...vars };
    for (const key of REPO_ENV) delete env[key];
    const started = Date.now();
    let output = '';
    let timedOut = false;
    let settled = false;
    let hardKill;
    let linger;
    let child;

    const append = (chunk) => {
      output += chunk;
      if (output.length > MAX_OUTPUT * 2) output = output.slice(-MAX_OUTPUT);
    };
    const killGroup = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {}
    };
    const forward = () => killGroup('SIGTERM');
    const finish = (status, signal, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardKill);
      clearTimeout(linger);
      for (const s of FORWARDED) signals.off(s, forward);
      const text = output.length > MAX_OUTPUT ? `… (output truncated)\n${output.slice(-MAX_OUTPUT)}` : output;
      resolve({ status, signal, timedOut, output: text, error, durationMs: Date.now() - started });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      hardKill = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs);

    try {
      child = spawn(file, [], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish(null, null, error);
      return;
    }
    for (const s of FORWARDED) signals.on(s, forward);
    child.stdout.setEncoding('utf8').on('data', append);
    child.stderr.setEncoding('utf8').on('data', append);
    child.on('error', (error) => finish(null, null, error));
    child.on('exit', (status, signal) => {
      linger = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(status, signal);
      }, EXIT_GRACE_MS);
    });
    child.on('close', (status, signal) => finish(status, signal));
  });
}
```

`src/deps.js` — add the import and the entry:
```js
import { runHookFile } from './lib/hook-runner.js';
```
```js
  runHook: (opts) => runHookFile(opts),
```

`test/helpers.js` — add `import { runHookFile } from '../src/lib/hook-runner.js';` and, in `testDeps`, after `busyPorts`:
```js
    runHook: runHookFile,
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/hook-runner.test.js` → PASS. Then `npm run test:run` and `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/hook-runner.js src/deps.js test/helpers.js test/hook-runner.test.js
git commit -m "feat: hook runner with process-group timeout, output cap and signal forwarding

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Running an event under the hook policy

**Files:**
- Create: `src/lib/hook-events.js`
- Modify: `src/lib/lane-files.js` (`laneVars`), `src/lib/lanes-state.js` (request helpers), `src/lib/errors.js` (`HookError`)
- Test: `test/hook-events.test.js`

**Interfaces:**
- Consumes: Task 1 (`hookStates`, `hookDiff`, `isExecutable`), Task 2 (`deps.runHook`), `appendAudit`, `loadContainer` context `ctx = { root, paths, id, config, portRange }`, lane record shape from `lanes.json` (`{ number, repos: [{ name, path, branch }], ports }`).
- Produces:
  - `laneVars({ lane, number, containerId, laneDir, containerDir, ports, branch }) → Record<string, string>` (all values strings); `laneEnv(args)` now renders `laneVars`.
  - `requestId(kind, lane) → string`, `putRequest(state, { ts, lane = null, kind, text, command }) → state`, `dropRequests(state, match) → state` (pure).
  - `class HookError(message, exitCode, run)` — `.run` is the `HookRun`.
  - `HookRun = { event, policy, timeoutSec, hooks: [{ hook, state, checksum }], unapproved: [{ hook, state, checksum }], results: [{ hook, status, signal, timedOut, durationMs, output, untrusted }], outcome: 'ok'|'failed'|'blocked'|'refused', error: string|null, diffs?: [{ hook, state, diff }] }`
  - `runEvent(ctx, deps, { event, name, lane, cwd }) → Promise<HookRun>` — never throws for hook problems; audits each unapproved hook it runs (callers surface `unapprovedWarnings(run)` in their result's `warnings`; `runEvent` itself never calls `deps.warn`).
  - `dryRunHooks(ctx, event) → { event, policy, wouldRun, refused, hooks: [{ hook, state, checksum }] }`
  - `runSummary(run) → string`, `hookBoardEntries(run, { lane, now }) → { activity, requests }`, `hookError(run, next) → HookError`, `unapprovedWarnings(run) → string[]`
  - `setupFailedRequest(run, lane, ts)`, `setupFailedNext(run, lane) → string`, `lockRequest(config, ts)`, `lockSuggested(state, config, current) → boolean`, `HISTORY_CAP = 100`, `laneHookVars(ctx, name, lane)`

- [ ] **Step 1: Write the failing test**

`test/hook-events.test.js`:
```js
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadContainer } from '../src/lib/container.js';
import { approveHooks } from '../src/lib/hooks.js';
import { dryRunHooks, hookBoardEntries, hookError, lockSuggested, runEvent, runSummary, unapprovedWarnings } from '../src/lib/hook-events.js';
import { dropRequests, emptyLanesState, putRequest } from '../src/lib/lanes-state.js';
import { HookError } from '../src/lib/errors.js';
import { cleanupTmp, setupContainer, writeHook } from './helpers.js';

afterEach(cleanupTmp);

const LANE = { number: 1, repos: [{ name: 'my-app', path: 'lane_1', branch: 'main' }], ports: [20000, 20009] };

async function setup(policy = 'notify') {
  const s = await setupContainer();
  const ctx = loadContainer({ container: s.container }, s.deps);
  ctx.config.hooks.policy = policy;
  const laneDir = join(s.container, 'lane_1');
  mkdirSync(laneDir);
  const warnings = [];
  const deps = { ...s.deps, warn: (m) => warnings.push(m) };
  const run = (event = 'post-create') => runEvent(ctx, deps, { event, name: 'lane_1', lane: LANE, cwd: laneDir });
  return { ...s, ctx, deps, laneDir, run, warnings };
}

describe('runEvent', () => {
  it('succeeds with no hooks', async () => {
    const { run } = await setup();
    const r = await run();
    expect(r).toMatchObject({ event: 'post-create', outcome: 'ok', results: [], unapproved: [], error: null });
    expect(runSummary(r)).toBe('no hooks');
  });

  it('gives hooks the contract environment, in the working directory it was given', async () => {
    const { container, laneDir, run } = await setup();
    writeHook(container, 'post-create', 'env > env.txt; pwd -P > pwd.txt');
    expect((await run()).outcome).toBe('ok');
    const env = Object.fromEntries(
      readFileSync(join(laneDir, 'env.txt'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    expect(env).toMatchObject({
      LAINES_HOOK: 'post-create', LAINES_DRY_RUN: '0', LANE_NAME: 'lane_1', LANE_NUMBER: '1', LANE_ID: 'my-app/lane_1',
      LANE_DIR: laneDir, CONTAINER_DIR: container, CONTAINER_ID: 'my-app', LANE_PORT_BASE: '20000', LANE_PORT_COUNT: '10',
      LANE_SUFFIX: '_my_app_l1', LANE_BRANCH: 'main', LANE_ENV_FILE: join(laneDir, '.laines.env'), PORT: '20000', COMPOSE_PROJECT_NAME: 'my-app-l1',
    });
    expect(readFileSync(join(laneDir, 'pwd.txt'), 'utf8').trim()).toBe(laneDir);
  });

  it('runs the main hook then <event>.d/ in order, and stops at the first failure', async () => {
    const { container, laneDir, run } = await setup();
    writeHook(container, 'post-create', 'echo main >> order.txt');
    writeHook(container, 'post-create.d/10-a', 'echo a >> order.txt');
    writeHook(container, 'post-create.d/20-b', 'echo b >> order.txt; echo "b broke" >&2; exit 1');
    writeHook(container, 'post-create.d/30-c', 'echo c >> order.txt');
    const r = await run();
    expect(readFileSync(join(laneDir, 'order.txt'), 'utf8')).toBe('main\na\nb\n');
    expect(r.outcome).toBe('failed');
    expect(r.results.map((x) => [x.hook, x.status])).toEqual([['post-create', 0], ['post-create.d/10-a', 0], ['post-create.d/20-b', 1]]);
    expect(r.results[2]).toMatchObject({ untrusted: true });
    expect(r.results[2].output).toContain('b broke');
    expect(runSummary(r)).toBe('post-create.d/20-b exited 1');
    const err = hookError(r, 'Fix it.');
    expect(err).toBeInstanceOf(HookError);
    expect(err.exitCode).toBe(1);
    expect(err.run).toBe(r);
    expect(err.message).toContain("Hook output (untrusted: printed by the project's hook script):");
    expect(err.message).toContain('b broke');
    expect(err.message.endsWith('Fix it.')).toBe(true);
  });

  it('treats exit 3 as blocked on a human, not a failure', async () => {
    const { container, run } = await setup();
    writeHook(container, 'post-create', 'echo "start Postgres first"; exit 3');
    const r = await run();
    expect(r.outcome).toBe('blocked');
    expect(runSummary(r)).toBe('post-create exited 3 (needs a human)');
    expect(hookError(r, 'x').exitCode).toBe(3);
  });

  it('fails a hook without the executable bit with a chmod hint, without running it', async () => {
    const { container, laneDir, run } = await setup();
    writeHook(container, 'post-create', 'touch ran', { mode: 0o644 });
    const r = await run();
    expect(r.outcome).toBe('failed');
    expect(r.results[0]).toMatchObject({ status: null, untrusted: false });
    expect(r.results[0].output).toContain('chmod +x');
    expect(existsSync(join(laneDir, 'ran'))).toBe(false);
    expect(runSummary(r)).toBe('post-create could not run');
  });

  it('stops a hook that runs past hooks.timeoutSec', async () => {
    const { container, ctx, run } = await setup();
    ctx.config.hooks.timeoutSec = 1;
    writeHook(container, 'post-create', 'sleep 20');
    const r = await run();
    expect(r.outcome).toBe('failed');
    expect(r.results[0].timedOut).toBe(true);
    expect(runSummary(r)).toBe('post-create timed out after 1s');
  });

  it('policy notify runs new and changed hooks, with an audit entry and a warning line each', async () => {
    const { container, ctx, run } = await setup('notify');
    writeHook(container, 'post-create', 'true');
    const r = await run();
    expect(r.outcome).toBe('ok');
    expect(r.unapproved).toEqual([{ hook: 'post-create', state: 'new', checksum: expect.stringMatching(/^sha256:/) }]);
    expect(unapprovedWarnings(r)).toEqual([expect.stringMatching(/hook post-create is new and ran unapproved \(policy notify\)/)]);
    expect(readFileSync(ctx.paths.audit, 'utf8')).toContain('"action":"hook-unapproved"');
  });

  it('policy approve refuses new and changed hooks with their diffs, running none', async () => {
    const { container, ctx, laneDir, run } = await setup('approve');
    writeHook(container, 'post-create', 'touch ran');
    const refused = await run();
    expect(refused.outcome).toBe('refused');
    expect(refused.results).toEqual([]);
    expect(existsSync(join(laneDir, 'ran'))).toBe(false);
    expect(refused.diffs[0]).toMatchObject({ hook: 'post-create', state: 'new' });
    expect(refused.diffs[0].diff).toContain('+touch ran');
    const err = hookError(refused, 'Ask a human.');
    expect(err.exitCode).toBe(3);
    expect(err.message).toContain('+touch ran');

    approveHooks(ctx.paths);
    expect((await run()).outcome).toBe('ok');
    expect(existsSync(join(laneDir, 'ran'))).toBe(true);

    writeHook(container, 'post-create', 'touch ran2');
    const changed = await run();
    expect(changed.outcome).toBe('refused');
    expect(changed.diffs[0].diff).toContain('-touch ran');
    expect(changed.diffs[0].diff).toContain('+touch ran2');
  });

  it('policy open runs hooks without any check', async () => {
    const { container, run, warnings } = await setup('open');
    writeHook(container, 'post-create', 'true');
    const r = await run();
    expect(r).toMatchObject({ outcome: 'ok', unapproved: [] });
    expect(warnings).toEqual([]);
  });

  it('reports a malformed hooks.lock.json as a failed run instead of throwing', async () => {
    const { ctx, run } = await setup();
    writeFileSync(ctx.paths.hooksLock, '{');
    const r = await run();
    expect(r.outcome).toBe('failed');
    expect(r.error).toContain('Malformed file');
    expect(runSummary(r)).toMatch(/^could not check hooks: Malformed file/);
  });
});

describe('dryRunHooks', () => {
  it('lists what would run and whether the policy would refuse it', async () => {
    const { container, ctx } = await setup('approve');
    writeHook(container, 'post-create', 'true');
    expect(dryRunHooks(ctx, 'post-create')).toMatchObject({ event: 'post-create', policy: 'approve', wouldRun: false, refused: true, hooks: [{ hook: 'post-create', state: 'new' }] });
    ctx.config.hooks.policy = 'notify';
    expect(dryRunHooks(ctx, 'post-create')).toMatchObject({ wouldRun: true, refused: false });
    expect(dryRunHooks(ctx, 'pre-teardown')).toMatchObject({ wouldRun: false, refused: false, hooks: [] });
  });
});

describe('board entries and requests', () => {
  it('turns unapproved hooks into an activity line with the checksum and one container-wide request', async () => {
    const { container, run } = await setup('notify');
    writeHook(container, 'post-create', 'true');
    const r = await run();
    const b = hookBoardEntries(r, { lane: 'lane_1', now: '2026-09-29T12:00:00.000Z' });
    expect(b.activity).toHaveLength(1);
    expect(b.activity[0].text).toMatch(/unapproved hook\(s\) ran under policy notify: post-create \(new, sha256:[0-9a-f]{12}\)/);
    expect(b.requests).toEqual([expect.objectContaining({ lane: null, kind: 'hooks-changed', command: 'laines hooks approve' })]);
    expect(hookBoardEntries({ ...r, unapproved: [] }, { lane: 'lane_1', now: 'x' })).toEqual({ activity: [], requests: [] });
  });

  it('putRequest keeps one request per kind and lane, newest first; dropRequests removes matches', () => {
    let s = emptyLanesState();
    s = putRequest(s, { ts: 't1', lane: 'lane_1', kind: 'setup-failed', text: 'a', command: 'c' });
    s = putRequest(s, { ts: 't2', kind: 'hooks-changed', text: 'b', command: 'c' });
    s = putRequest(s, { ts: 't3', lane: 'lane_1', kind: 'setup-failed', text: 'a2', command: 'c' });
    expect(s.requests.map((q) => [q.id, q.text])).toEqual([['setup-failed:lane_1', 'a2'], ['hooks-changed:*', 'b']]);
    expect(dropRequests(s, (q) => q.lane === 'lane_1').requests.map((q) => q.id)).toEqual(['hooks-changed:*']);
  });
});

describe('lockSuggested', () => {
  const config = (policy = 'notify') => ({ hooks: { policy, stableAfter: 2 } });
  const history = (...sets) => ({ ...emptyLanesState(), hookHistory: sets.map((checksums, i) => ({ ts: `t${i}`, checksums })) });
  const A = { 'post-create': 'sha256:a' };
  const B = { 'post-create': 'sha256:b' };

  it('suggests a lock once the last stableAfter creates saw the current, non-empty hook set', () => {
    expect(lockSuggested(history(B, A, A), config(), A)).toBe(true);
    expect(lockSuggested(history(A), config(), A)).toBe(false);
    expect(lockSuggested(history(A, B), config(), B)).toBe(false);
    expect(lockSuggested(history(A, A), config(), B)).toBe(false);
    expect(lockSuggested(history(A, A), config('approve'), A)).toBe(false);
    expect(lockSuggested(history({}, {}), config(), {})).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/hook-events.test.js`
Expected: FAIL — cannot resolve `../src/lib/hook-events.js`.

- [ ] **Step 3: Implement the supporting changes**

`src/lib/errors.js` — append:
```js
// A hook that failed, exited 3, or was refused by the policy. `run` carries the structured result
// (the MCP server hands it to agents); hook output inside it is untrusted.
export class HookError extends LainesError {
  constructor(message, exitCode, run) {
    super(message, exitCode);
    this.run = run;
  }
}
```

`src/lib/lanes-state.js` — append:
```js
export const requestId = (kind, lane) => `${kind}:${lane ?? '*'}`;

// Pure. One request per kind and lane: a repeat replaces the earlier one and moves to the top.
export function putRequest(state, { ts, lane = null, kind, text, command }) {
  const id = requestId(kind, lane);
  return { ...state, requests: [{ id, ts, lane, kind, text, command }, ...state.requests.filter((r) => r.id !== id)] };
}

export const dropRequests = (state, match) => ({ ...state, requests: state.requests.filter((r) => !match(r)) });
```

`src/lib/lane-files.js` — replace `laneEnv` with:
```js
// Spec §8.3: the lane's variables, shared by .laines.env and the hook environment.
export function laneVars({ lane, number, containerId, laneDir, containerDir, ports, branch }) {
  const vars = {
    LANE_NAME: lane,
    LANE_NUMBER: number,
    LANE_ID: laneId(containerId, lane),
    LANE_DIR: laneDir,
    CONTAINER_DIR: containerDir,
    CONTAINER_ID: containerId,
    LANE_PORT_BASE: ports[0],
    LANE_PORT_COUNT: ports[1] - ports[0] + 1,
    LANE_SUFFIX: laneSuffix(containerId, number),
    LANE_BRANCH: branch,
    LANE_ENV_FILE: join(laneDir, '.laines.env'),
    PORT: ports[0],
    COMPOSE_PROJECT_NAME: composeProject(containerId, number),
  };
  return Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, String(v)]));
}

export function laneEnv(args) {
  const lines = Object.entries(laneVars(args)).map(([k, v]) => `${k}=${q(v)}`);
  return (
    `# Generated by laines for lane ${args.lane}. Source it before starting services.\n` +
    '# `laines refresh` rewrites this file and re-runs post-create: hand edits are lost.\n' +
    `${lines.join('\n')}\n`
  );
}
```

- [ ] **Step 4: Implement `src/lib/hook-events.js`**

```js
import { join } from 'node:path';
import { appendAudit } from './audit.js';
import { hookDiff, hookStates, isExecutable } from './hooks.js';
import { laneVars } from './lane-files.js';
import { EXIT_CODES, HookError } from './errors.js';

export const HISTORY_CAP = 100;

const short = (sum) => sum.slice(0, 'sha256:'.length + 12);

export function laneHookVars(ctx, name, lane) {
  return laneVars({
    lane: name,
    number: lane.number,
    containerId: ctx.id,
    laneDir: join(ctx.root, lane.repos[0].path),
    containerDir: ctx.root,
    ports: lane.ports,
    branch: lane.repos[0].branch,
  });
}

const brief = (h) => ({ hook: h.rel, state: h.state, checksum: h.checksum });

// Spec §8.3–8.4: run one event's hooks in order under the hook policy. Returns data only; the
// caller records it through updateLanes. Must never be called while the container lock is held.
export async function runEvent(ctx, deps, { event, name, lane, cwd }) {
  const { policy, timeoutSec } = ctx.config.hooks;
  const run = { event, policy, timeoutSec, hooks: [], unapproved: [], results: [], outcome: 'ok', error: null };
  let hooks;
  try {
    ({ hooks } = hookStates(ctx.paths, [event]));
  } catch (err) {
    return { ...run, outcome: 'failed', error: err.message.split('\n')[0] };
  }
  run.hooks = hooks.map(brief);
  const unapproved = policy === 'open' ? [] : hooks.filter((h) => h.state !== 'approved');
  run.unapproved = unapproved.map(brief);
  if (policy === 'approve' && unapproved.length) {
    return { ...run, outcome: 'refused', diffs: unapproved.map((h) => ({ hook: h.rel, state: h.state, diff: hookDiff(deps, ctx.paths, h) })) };
  }
  // The warning itself reaches the user through the command's `warnings` (unapprovedWarnings).
  for (const h of unapproved) {
    appendAudit(
      ctx.paths.audit,
      { ts: deps.now(), action: 'hook-unapproved', container: ctx.id, lane: name, hook: h.rel, state: h.state, checksum: h.checksum, policy },
      { warn: deps.warn },
    );
  }
  const vars = { ...laneHookVars(ctx, name, lane), LAINES_HOOK: event, LAINES_DRY_RUN: '0' };
  for (const h of hooks) {
    if (!isExecutable(h.path)) {
      run.results.push({ hook: h.rel, status: null, signal: null, timedOut: false, durationMs: 0, untrusted: false, output: `${h.path} is not executable: run chmod +x on it.` });
      return { ...run, outcome: 'failed' };
    }
    const r = await deps.runHook({ file: h.path, cwd, vars, timeoutMs: timeoutSec * 1000 });
    run.results.push({
      hook: h.rel,
      status: r.status,
      signal: r.signal ?? null,
      timedOut: r.timedOut,
      durationMs: r.durationMs,
      untrusted: true,
      output: r.output || (r.error ? r.error.message : ''),
    });
    if (r.status === 3) return { ...run, outcome: 'blocked' };
    if (r.status !== 0) return { ...run, outcome: 'failed' };
  }
  return run;
}

export function dryRunHooks(ctx, event) {
  const { policy } = ctx.config.hooks;
  const { hooks } = hookStates(ctx.paths, [event]);
  const refused = policy === 'approve' && hooks.some((h) => h.state !== 'approved');
  return { event, policy, wouldRun: !refused && hooks.length > 0, refused, hooks: hooks.map(brief) };
}

export function runSummary(run) {
  if (run.error) return `could not check hooks: ${run.error}`;
  if (run.outcome === 'refused') {
    return `refused under policy approve: ${run.unapproved.map((u) => `${u.hook} (${u.state})`).join(', ')} not approved`;
  }
  if (run.outcome === 'ok') return run.results.length ? `${run.results.length} hook(s) ran` : 'no hooks';
  const last = run.results.at(-1);
  const why = last.timedOut
    ? `timed out after ${run.timeoutSec}s`
    : last.signal
      ? `was stopped by ${last.signal}`
      : last.status === null
        ? 'could not run'
        : `exited ${last.status}`;
  return `${last.hook} ${why}${run.outcome === 'blocked' ? ' (needs a human)' : ''}`;
}

// Spec §8.4 (notify): a board note with the new checksum, and one container-wide request to approve.
export function hookBoardEntries(run, { lane, now }) {
  if (!run.unapproved.length) return { activity: [], requests: [] };
  const list = run.unapproved.map((u) => `${u.hook} (${u.state}, ${short(u.checksum)})`).join(', ');
  const text = run.outcome === 'refused'
    ? `${run.event} refused under policy approve: ${list}`
    : `unapproved hook(s) ran under policy ${run.policy}: ${list}`;
  return {
    activity: [{ ts: now, lane, text }],
    requests: [{
      ts: now,
      lane: null,
      kind: 'hooks-changed',
      text: `hooks changed since the last approval: ${run.unapproved.map((u) => u.hook).join(', ')}. Review with \`laines hooks status\``,
      command: 'laines hooks approve',
    }],
  };
}

export const unapprovedWarnings = (run) =>
  run.outcome === 'refused'
    ? []
    : run.unapproved.map((u) => `hook ${u.hook} is ${u.state} and ran unapproved (policy ${run.policy}); review it with \`laines hooks status\``);

export function hookError(run, next) {
  const lines = [`${run.event} ${runSummary(run)}.`];
  if (run.outcome === 'refused') {
    for (const d of run.diffs) lines.push('', `--- ${d.hook} (${d.state}) ---`, d.diff.trimEnd() || '(no diff)');
  } else if (run.results.length) {
    const last = run.results.at(-1);
    if (last.untrusted) lines.push("Hook output (untrusted: printed by the project's hook script):");
    lines.push(last.output.trimEnd() || '(no output)');
  }
  lines.push('', next);
  return new HookError(lines.join('\n'), run.outcome === 'failed' ? EXIT_CODES.GENERIC : EXIT_CODES.BLOCKED, run);
}

export function setupFailedRequest(run, lane, ts) {
  const refresh = `laines refresh ${lane}`;
  return {
    ts,
    lane,
    kind: 'setup-failed',
    text: `post-create ${runSummary(run)}`,
    command: run.outcome === 'refused' ? `laines hooks approve && ${refresh}` : refresh,
  };
}

export function setupFailedNext(run, lane) {
  const head = `Lane ${lane} is kept on disk and marked setup-failed.`;
  return run.outcome === 'refused'
    ? `${head} A human must review the hooks (\`laines hooks status\`) and approve them (\`laines hooks approve\`); then run \`laines refresh ${lane}\`.`
    : `${head} Fix the hook or what it needs, then run \`laines refresh ${lane}\`.`;
}

export const lockRequest = (config, ts) => ({
  ts,
  lane: null,
  kind: 'hooks-lock',
  text: `hooks unchanged across the last ${config.hooks.stableAfter} successful creates: consider locking them`,
  command: 'laines hooks approve --lock',
});

const sameSet = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

// Spec §8.4: suggest (never apply) a lock once the hook set has been unchanged across the last
// stableAfter successful creates.
export function lockSuggested(state, config, current) {
  const { policy, stableAfter } = config.hooks;
  if (policy === 'approve' || !Object.keys(current).length) return false;
  const recent = state.hookHistory.slice(-stableAfter);
  return recent.length === stableAfter && recent.every((h) => sameSet(h.checksums, current));
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/hook-events.test.js test/lane-files.test.js` → PASS. Then `npm run test:run` and `npm run lint`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/hook-events.js src/lib/lane-files.js src/lib/lanes-state.js src/lib/errors.js test/hook-events.test.js
git commit -m "feat: run lane events under the hook policy, with keyed board requests

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `post-create` in `create`

**Files:**
- Modify: `src/commands/create.js`, `src/lib/format.js`
- Test: `test/create.test.js`

**Interfaces:**
- Consumes: Task 1 (`hookStates`, `currentChecksums`), Task 3 (`runEvent`, `dryRunHooks`, `hookBoardEntries`, `hookError`, `runSummary`, `unapprovedWarnings`, `setupFailedRequest`, `setupFailedNext`, `lockRequest`, `lockSuggested`, `HISTORY_CAP`, `putRequest`).
- Produces:
  - `runCreate` result gains `hooks` (a `HookRun`; on dry run the `dryRunHooks` shape). A hook problem throws `HookError` (exit 1 failed; exit 3 blocked or refused) **after** the lane is recorded as `setup-failed`.
  - `formatDryHooks(h) → string` in `src/lib/format.js` (used by Tasks 5 and 6).
  - Explicit lane numbers: only `<lanePrefix>` followed by `^[1-9]\d*$` claims a number; `lane_003`, `lane_0` are custom names.

- [ ] **Step 1: Write the failing tests**

In `test/create.test.js`, extend the imports:
```js
import { HookError, MalformedConfigError } from '../src/lib/errors.js';
import { cleanupTmp, setupContainer, gitIn, runCli, writeHook, setConfig } from './helpers.js';
```
(keep the existing error imports in the same statement: `BlockedError, GitError, HookError, InvalidInputError, MalformedConfigError`), and append:
```js
describe('create with hooks', () => {
  const lanes = (container, deps) => readLanes(loadContainer({ container }, deps));
  const board = (container) => readFileSync(join(container, '.ai', 'context', 'LANES_BOARD.md'), 'utf8');

  it('runs post-create in the lane after .laines.env is written, and records the hook set', async () => {
    const { deps, container } = await setupContainer();
    writeHook(container, 'post-create', 'grep -q LANE_SUFFIX "$LANE_ENV_FILE" && echo "DATABASE_URL=postgres://localhost/app$LANE_SUFFIX" >> "$LANE_ENV_FILE"');
    const r = await runCreate({ container }, deps);
    expect(r.hooks).toMatchObject({ event: 'post-create', outcome: 'ok' });
    expect(readFileSync(join(r.path, '.laines.env'), 'utf8')).toContain('DATABASE_URL=postgres://localhost/app_my_app_l1');
    expect(gitIn(r.path, 'status', '--porcelain')).toBe('');
    const st = lanes(container, deps);
    expect(st.lanes.lane_1).toMatchObject({ state: 'active', status: 'idle' });
    expect(st.hookHistory).toHaveLength(1);
    expect(Object.keys(st.hookHistory[0].checksums)).toEqual(['post-create']);
    expect(r.warnings).toEqual([expect.stringMatching(/hook post-create is new and ran unapproved \(policy notify\)/)]);
    expect(board(container)).toMatch(/unapproved hook\(s\) ran under policy notify: post-create \(new, sha256:/);
  });

  it('keeps a lane whose post-create fails, marks it setup-failed and asks for a refresh', async () => {
    const { deps, container } = await setupContainer();
    writeHook(container, 'post-create', 'echo "db down" >&2; exit 1');
    const err = await runCreate({ container }, deps).catch((e) => e);
    expect(err).toBeInstanceOf(HookError);
    expect(err.exitCode).toBe(1);
    expect(err.message).toContain('db down');
    expect(err.message).toContain('untrusted');
    expect(err.message).toContain('laines refresh lane_1');
    expect(existsSync(join(container, 'lane_1', '.laines.env'))).toBe(true);
    const st = lanes(container, deps);
    expect(st.lanes.lane_1).toMatchObject({ state: 'setup-failed', status: 'setup-failed' });
    expect(st.requests.find((q) => q.id === 'setup-failed:lane_1')).toMatchObject({ command: 'laines refresh lane_1' });
    expect(st.hookHistory).toEqual([]);
    expect(board(container)).toContain('⚠️ setup-failed');
  });

  it('exits 3 when post-create exits 3', async () => {
    const { deps, container } = await setupContainer();
    writeHook(container, 'post-create', 'echo "start Postgres, then refresh"; exit 3');
    const err = await runCreate({ container }, deps).catch((e) => e);
    expect(err.exitCode).toBe(3);
    expect(lanes(container, deps).lanes.lane_1.state).toBe('setup-failed');
  });

  it('under policy approve, refuses an unapproved hook without running it', async () => {
    const { deps, container } = await setupContainer();
    setConfig(container, (c) => { c.hooks.policy = 'approve'; });
    writeHook(container, 'post-create', 'touch "$LANE_DIR/ran"');
    const err = await runCreate({ container }, deps).catch((e) => e);
    expect(err).toBeInstanceOf(HookError);
    expect(err.exitCode).toBe(3);
    expect(err.message).toContain('+touch "$LANE_DIR/ran"');
    expect(existsSync(join(container, 'lane_1', 'ran'))).toBe(false);
    const st = lanes(container, deps);
    expect(st.requests.map((q) => q.id).sort()).toEqual(['hooks-changed:*', 'setup-failed:lane_1']);
    expect(st.requests.find((q) => q.kind === 'setup-failed').command).toBe('laines hooks approve && laines refresh lane_1');
  });

  it('suggests locking once the hook set is unchanged across stableAfter creates', async () => {
    const { deps, container } = await setupContainer();
    setConfig(container, (c) => { c.hooks.stableAfter = 2; });
    writeHook(container, 'post-create', 'true');
    const a = await runCreate({ container }, deps);
    expect(a.next.join('\n')).not.toContain('--lock');
    const b = await runCreate({ container }, deps);
    expect(b.next.at(-1)).toContain('laines hooks approve --lock');
    expect(lanes(container, deps).requests.map((q) => q.id)).toContain('hooks-lock:*');
    expect(board(container)).toContain('`laines hooks approve --lock`');
    writeHook(container, 'post-create', 'true # changed');
    const c = await runCreate({ container }, deps);
    expect(c.next.join('\n')).not.toContain('--lock');
    expect(lanes(container, deps).requests.map((q) => q.id)).not.toContain('hooks-lock:*');
  });

  it('dry run lists the hooks that would run and runs none', async () => {
    const { deps, container } = await setupContainer();
    writeHook(container, 'post-create', 'touch "$CONTAINER_DIR/ran"');
    const r = await runCreate({ container, dryRun: true }, deps);
    expect(r.hooks).toMatchObject({ event: 'post-create', wouldRun: true, hooks: [{ hook: 'post-create', state: 'new' }] });
    expect(existsSync(join(container, 'ran'))).toBe(false);
  });

  it('fails before cloning when hooks.lock.json is malformed', async () => {
    const { deps, container } = await setupContainer();
    writeFileSync(join(container, '.laines', 'hooks.lock.json'), '{');
    await expect(runCreate({ container }, deps)).rejects.toBeInstanceOf(MalformedConfigError);
    expect(existsSync(join(container, 'lane_1'))).toBe(false);
    expect(lanes(container, deps).lanes).toEqual({});
  });

  it('treats lane_003 as a custom name, not lane number 3', async () => {
    const { deps, container } = await setupContainer();
    expect(await runCreate({ container, name: 'lane_003' }, deps)).toMatchObject({ lane: 'lane_003', number: 1 });
  });
});
```

Also in `test/create.test.js`, in the existing test `'uses the number in an explicit prefixed name'`, replace the `lane_0` line (it now names a custom lane, which gets the next free number):
```js
    expect(await runCreate({ container, name: 'lane_0', dryRun: true }, deps)).toMatchObject({ lane: 'lane_0', number: 2 });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/create.test.js`
Expected: the new tests FAIL (no `hooks` in the result, no hook run, `lane_003` and `lane_0` claim numbers).

- [ ] **Step 3: Implement**

`src/commands/create.js` — new imports (merge with the existing ones):
```js
import { dropRequests, putRequest, requestId } from '../lib/lanes-state.js';
import { currentChecksums, hookStates } from '../lib/hooks.js';
import {
  HISTORY_CAP, dryRunHooks, hookBoardEntries, hookError, lockRequest, lockSuggested,
  runEvent, runSummary, setupFailedNext, setupFailedRequest, unapprovedWarnings,
} from '../lib/hook-events.js';
```

Replace `explicitNumber`'s match line and comment:
```js
// An explicit `<lanePrefix><N>` name claims lane number N, so the name and the ports agree. Only a
// canonical number counts: `lane_003` or `lane_0` is a custom name.
function explicitNumber(ctx, name) {
  const prefix = ctx.config.lanePrefix;
  if (name === undefined || !name.startsWith(prefix)) return null;
  const m = /^[1-9]\d*$/.exec(name.slice(prefix.length));
  return m ? Number(m[0]) : null;
}
```

In `runCreate`, right after `validate(ctx, deps, opts, branch);`:
```js
  // A malformed hooks.lock.json fails here, before anything is cloned or reserved.
  hookStates(ctx.paths);
```
In the dry-run return object, add `hooks: dryRunHooks(ctx, 'post-create')` after `warnings: []`.

Replace everything from the `// M3: run the post-create hook here.` line to the end of the function with:
```js
  // Spec §10.2 steps 5–6: post-create runs once the lane is on disk, outside the lock. A failed hook
  // keeps the lane as setup-failed so it can be fixed and refreshed.
  const record = { number: plan.number, repos: [{ name: repoName, path: plan.name, branch }], ports: plan.ports };
  const run = await runEvent(ctx, deps, { event: 'post-create', name: plan.name, lane: record, cwd: plan.laneDir });
  const ok = run.outcome === 'ok';
  const checksums = ok ? currentChecksums(ctx.paths) : null;
  let suggestLock = false;

  const lane = await updateLanes(ctx, deps, (s) => {
    const ts = deps.now();
    const board = hookBoardEntries(run, { lane: plan.name, now: ts });
    let state = board.requests.reduce(putRequest, s);
    const l = getLane(state, plan.name);
    l.updated = ts;
    if (ok) {
      l.status = 'idle';
      state.hookHistory = [...state.hookHistory, { ts, checksums }].slice(-HISTORY_CAP);
      suggestLock = lockSuggested(state, ctx.config, checksums);
      // The suggestion tracks the current set: a changed set withdraws it.
      state = suggestLock
        ? putRequest(state, lockRequest(ctx.config, ts))
        : dropRequests(state, (q) => q.id === requestId('hooks-lock', null));
    } else {
      l.state = 'setup-failed';
      l.status = 'setup-failed';
      state = putRequest(state, setupFailedRequest(run, plan.name, ts));
    }
    const text = ok ? `lane created on branch ${branch}` : `lane created on branch ${branch}; setup failed: post-create ${runSummary(run)}`;
    return { state, result: l, activity: [...board.activity, { ts, lane: plan.name, text }] };
  });
  appendAudit(ctx.paths.audit, { ts: deps.now(), action: 'create', container: ctx.id, lane: plan.name, branch, hooks: run.outcome }, { warn: deps.warn });
  if (!ok) throw hookError(run, setupFailedNext(run, plan.name));

  const { stableAfter } = ctx.config.hooks;
  return {
    dryRun: false,
    lane: plan.name,
    id: laneId(ctx.id, plan.name),
    number: plan.number,
    path: plan.laneDir,
    branch,
    ports: plan.ports,
    files: files.written,
    warnings: [...files.skipped.map((s) => `${s.file} not written: ${s.reason}`), ...unapprovedWarnings(run)],
    hooks: run,
    brief: buildBrief(ctx, plan.name, lane),
    next: [
      `cd ${shellQuote(plan.laneDir)} && ${ctx.config.agentCmd}`,
      `or hand \`laines brief ${plan.name}\` to a subagent`,
      ...(suggestLock ? [`hooks have been unchanged across the last ${stableAfter} creates: a human can lock them with \`laines hooks approve --lock\``] : []),
    ],
  };
}
```

`src/lib/format.js` — add at the top `import { runSummary } from './hook-events.js';`, add:
```js
export function formatDryHooks(h) {
  const list = h.hooks.length ? h.hooks.map((x) => `${x.hook} (${x.state})`).join(', ') : 'none';
  return `hooks:   ${h.event}: ${list}${h.refused ? ' — would be refused (policy approve)' : ''}`;
}
```
and replace `formatCreate` with:
```js
export function formatCreate(r) {
  const head = [
    r.dryRun ? `dry run: would create ${r.lane} (${r.id})` : `lane ${r.lane} created`,
    `path:    ${r.path}`,
    `branch:  ${r.branch}`,
    `ports:   ${r.ports[0]}–${r.ports[1]}`,
  ];
  if (r.dryRun) return [...head, `remote:  ${r.remote}`, formatDryHooks(r.hooks)].join('\n');
  const lines = [...head, `hooks:   post-create ${runSummary(r.hooks)}`, ...r.warnings.map((w) => `warning: ${w}`), '', r.brief.text, 'next:', ...r.next.map((s) => `  ${s}`)];
  return lines.join('\n');
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/create.test.js` → PASS. Then `npm run test:run` and `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/commands/create.js src/lib/format.js test/create.test.js
git commit -m "feat: run post-create on create; keep failed lanes as setup-failed

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `refresh`

**Files:**
- Create: `src/commands/refresh.js`
- Modify: `src/cli.js`, `src/lib/format.js`
- Test: `test/refresh.test.js`

**Interfaces:**
- Consumes: Task 3 (`runEvent`, `dryRunHooks`, `hookBoardEntries`, `hookError`, `runSummary`, `unapprovedWarnings`, `setupFailedRequest`, `setupFailedNext`, `putRequest`, `dropRequests`, `requestId`), Task 4 (`formatDryHooks`), M2 (`writeLaneFiles`, `assertLaneDir`, `laneFrom`, `loadContainer`).
- Produces:
  - `runRefresh({ lane?, dryRun?, container? }, deps)` → dry run `{ dryRun: true, lane, path, hooks }`; otherwise `{ dryRun: false, lane, path, branch, files, warnings, hooks }`. Throws `HookError` (lane left `setup-failed`) when `post-create` does not succeed.
  - CLI `laines refresh [lane] [--dry-run]`, `formatRefresh(r)`.

- [ ] **Step 1: Write the failing test**

`test/refresh.test.js`:
```js
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCreate } from '../src/commands/create.js';
import { runRefresh } from '../src/commands/refresh.js';
import { runTeardown } from '../src/commands/teardown.js';
import { loadContainer } from '../src/lib/container.js';
import { readLanes, updateLanes } from '../src/lib/lanes-store.js';
import { approveHooks } from '../src/lib/hooks.js';
import { HookError, InvalidInputError } from '../src/lib/errors.js';
import { cleanupTmp, setupContainer, gitIn, runCli, writeHook, setConfig } from './helpers.js';

afterEach(cleanupTmp);

const ctxOf = (s) => loadContainer({ container: s.container }, s.deps);
const lane1 = (s) => readLanes(ctxOf(s)).lanes.lane_1;

describe('refresh', () => {
  it('rewrites .laines.env and re-runs post-create, so appended lines appear exactly once', async () => {
    const s = await setupContainer();
    writeHook(s.container, 'post-create', 'echo "DB=app$LANE_SUFFIX" >> "$LANE_ENV_FILE"');
    const { path } = await runCreate({ container: s.container }, s.deps);
    writeFileSync(join(path, '.laines.env'), 'hand edit\n');
    rmSync(join(path, '.ai', 'README.md'));
    await runRefresh({ lane: 'lane_1', container: s.container }, s.deps);
    const r = await runRefresh({ lane: 'lane_1', container: s.container }, s.deps);
    expect(r).toMatchObject({ dryRun: false, lane: 'lane_1', branch: 'main', hooks: { outcome: 'ok' } });
    const env = readFileSync(join(path, '.laines.env'), 'utf8');
    expect(env.match(/^DB=/gm)).toHaveLength(1);
    expect(env).toContain('LANE_NAME="lane_1"');
    expect(env).not.toContain('hand edit');
    expect(existsSync(join(path, '.ai', 'README.md'))).toBe(true);
    expect(gitIn(path, 'status', '--porcelain')).toBe('');
    expect(readFileSync(ctxOf(s).paths.audit, 'utf8')).toContain('"action":"refresh"');
  });

  it('recovers a setup-failed lane once the hook is fixed', async () => {
    const s = await setupContainer();
    writeHook(s.container, 'post-create', 'exit 1');
    await expect(runCreate({ container: s.container }, s.deps)).rejects.toBeInstanceOf(HookError);
    writeHook(s.container, 'post-create', 'true');
    await runRefresh({ lane: 'lane_1', container: s.container }, s.deps);
    expect(lane1(s)).toMatchObject({ state: 'active', status: 'idle' });
    expect(readLanes(ctxOf(s)).requests.filter((q) => q.lane === 'lane_1')).toEqual([]);
    expect(readFileSync(ctxOf(s).paths.board, 'utf8')).not.toContain('⚠️ setup-failed');
  });

  it('recovers a lane refused under policy approve once a human approves the hooks', async () => {
    const s = await setupContainer();
    setConfig(s.container, (c) => { c.hooks.policy = 'approve'; });
    writeHook(s.container, 'post-create', 'touch "$LANE_DIR/ran"');
    await expect(runCreate({ container: s.container }, s.deps)).rejects.toMatchObject({ exitCode: 3 });
    approveHooks(ctxOf(s).paths);
    await runRefresh({ lane: 'lane_1', container: s.container }, s.deps);
    expect(existsSync(join(s.container, 'lane_1', 'ran'))).toBe(true);
    expect(lane1(s).state).toBe('active');
  });

  it('marks the lane setup-failed when post-create fails on refresh', async () => {
    const s = await setupContainer();
    await runCreate({ container: s.container }, s.deps);
    writeHook(s.container, 'post-create', 'echo nope >&2; exit 2');
    const err = await runRefresh({ lane: 'lane_1', container: s.container }, s.deps).catch((e) => e);
    expect(err).toBeInstanceOf(HookError);
    expect(err.exitCode).toBe(1);
    expect(err.message).toContain('laines refresh lane_1');
    expect(lane1(s)).toMatchObject({ state: 'setup-failed', status: 'setup-failed' });
    expect(readLanes(ctxOf(s)).requests.map((q) => q.id)).toContain('setup-failed:lane_1');
  });

  it('rescues a lane left "spinning up" by an interrupted create', async () => {
    const s = await setupContainer();
    await runCreate({ container: s.container }, s.deps);
    await updateLanes(ctxOf(s), s.deps, (st) => {
      st.lanes.lane_1.status = 'spinning up';
      return { state: st, result: null };
    });
    await runRefresh({ lane: 'lane_1', container: s.container }, s.deps);
    expect(lane1(s)).toMatchObject({ state: 'active', status: 'idle' });
  });

  it('records the branch the clone is on now', async () => {
    const s = await setupContainer();
    const { path } = await runCreate({ container: s.container }, s.deps);
    gitIn(path, 'checkout', '-q', '-b', 'feat/x');
    const r = await runRefresh({ lane: 'lane_1', container: s.container }, s.deps);
    expect(r.branch).toBe('feat/x');
    expect(lane1(s).repos[0].branch).toBe('feat/x');
    expect(readFileSync(join(path, '.laines.env'), 'utf8')).toContain('LANE_BRANCH="feat/x"');
  });

  it('dry run lists hooks and changes nothing', async () => {
    const s = await setupContainer();
    const { path } = await runCreate({ container: s.container }, s.deps);
    writeHook(s.container, 'post-create', 'touch "$LANE_DIR/ran"');
    writeFileSync(join(path, '.laines.env'), 'x\n');
    const r = await runRefresh({ lane: 'lane_1', dryRun: true, container: s.container }, s.deps);
    expect(r).toMatchObject({ dryRun: true, lane: 'lane_1', hooks: { event: 'post-create', wouldRun: true } });
    expect(readFileSync(join(path, '.laines.env'), 'utf8')).toBe('x\n');
    expect(existsSync(join(path, 'ran'))).toBe(false);
  });

  it('refuses a closed lane and a lane whose clone is missing', async () => {
    const s = await setupContainer();
    await runCreate({ container: s.container }, s.deps);
    const two = await runCreate({ container: s.container }, s.deps);
    await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    await expect(runRefresh({ lane: 'lane_1', container: s.container }, s.deps)).rejects.toBeInstanceOf(InvalidInputError);
    rmSync(two.path, { recursive: true, force: true });
    await expect(runRefresh({ lane: 'lane_2', container: s.container }, s.deps)).rejects.toThrow(/laines teardown lane_2/);
  });

  it('wires into the CLI and finds the lane from inside it', async () => {
    const s = await setupContainer();
    const { path } = await runCreate({ container: s.container }, s.deps);
    const r = await runCli(['refresh', '--format', 'table'], { ...s.deps, cwd: () => path });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('lane lane_1 refreshed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/refresh.test.js`
Expected: FAIL — cannot resolve `../src/commands/refresh.js`.

- [ ] **Step 3: Implement**

`src/commands/refresh.js`:
```js
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { laneFrom, loadContainer } from '../lib/container.js';
import { getLane, readLanes, updateLanes } from '../lib/lanes-store.js';
import { dropRequests, putRequest, requestId } from '../lib/lanes-state.js';
import { assertLaneDir } from '../lib/containment.js';
import { writeLaneFiles } from '../lib/lane-files.js';
import {
  dryRunHooks, hookBoardEntries, hookError, runEvent, runSummary, setupFailedNext, setupFailedRequest, unapprovedWarnings,
} from '../lib/hook-events.js';
import { appendAudit } from '../lib/audit.js';
import { InvalidInputError } from '../lib/errors.js';

// Rewrites the lane-local files and .laines.env from scratch, then re-runs post-create. The way to
// recover a setup-failed lane, and to pick up changed hooks or templates.
export async function runRefresh(opts, deps) {
  const ctx = loadContainer(opts, deps);
  const name = laneFrom(opts, deps);
  const lane = getLane(readLanes(ctx), name);
  if (!lane) throw new InvalidInputError(`No lane named ${name}. See \`laines list\`.`);
  if (lane.state === 'closed') throw new InvalidInputError(`Lane ${name} is closed. Create a new lane instead.`);
  const laneDir = join(ctx.root, lane.repos[0].path);
  const real = assertLaneDir(ctx.root, laneDir, lane.repos[0].path);
  if (!real || !existsSync(join(real, '.git'))) {
    throw new InvalidInputError(`${laneDir} is missing or not a git clone. Tear the lane down (\`laines teardown ${name} --remove-dir --force\`) and create it again.`);
  }
  if (opts.dryRun) return { dryRun: true, lane: name, path: laneDir, hooks: dryRunHooks(ctx, 'post-create') };

  // The board and LANE_BRANCH follow the branch the clone is on now; a detached HEAD keeps the old one.
  const head = deps.git(['branch', '--show-current'], { cwd: real });
  const branch = head.status === 0 && head.stdout.trim() ? head.stdout.trim() : lane.repos[0].branch;
  const record = { ...lane, repos: [{ ...lane.repos[0], branch }] };
  const files = writeLaneFiles(ctx, deps, { name, number: lane.number, laneDir, branch, ports: lane.ports });
  const run = await runEvent(ctx, deps, { event: 'post-create', name, lane: record, cwd: real });
  const ok = run.outcome === 'ok';

  await updateLanes(ctx, deps, (s) => {
    const ts = deps.now();
    const board = hookBoardEntries(run, { lane: name, now: ts });
    let state = board.requests.reduce(putRequest, s);
    const l = getLane(state, name);
    if (!l || l.state === 'closed') throw new InvalidInputError(`Lane ${name} was torn down while it was being refreshed.`);
    l.repos[0].branch = branch;
    l.updated = ts;
    if (ok) {
      if (l.state === 'setup-failed' || l.status === 'spinning up') {
        l.state = 'active';
        l.status = 'idle';
      }
      state = dropRequests(state, (q) => q.id === requestId('setup-failed', name));
    } else {
      l.state = 'setup-failed';
      l.status = 'setup-failed';
      state = putRequest(state, setupFailedRequest(run, name, ts));
    }
    const text = ok ? `lane refreshed (post-create: ${runSummary(run)})` : `refresh failed: post-create ${runSummary(run)}`;
    return { state, result: null, activity: [...board.activity, { ts, lane: name, text }] };
  });
  appendAudit(ctx.paths.audit, { ts: deps.now(), action: 'refresh', container: ctx.id, lane: name, hooks: run.outcome }, { warn: deps.warn });
  if (!ok) throw hookError(run, setupFailedNext(run, name));
  return {
    dryRun: false,
    lane: name,
    path: laneDir,
    branch,
    files: files.written,
    warnings: [...files.skipped.map((f) => `${f.file} not written: ${f.reason}`), ...unapprovedWarnings(run)],
    hooks: run,
  };
}
```

`src/lib/format.js` — add:
```js
export function formatRefresh(r) {
  if (r.dryRun) return [`dry run: would refresh ${r.lane}`, `path:    ${r.path}`, formatDryHooks(r.hooks)].join('\n');
  return [
    `lane ${r.lane} refreshed`,
    `path:    ${r.path}`,
    `branch:  ${r.branch}`,
    `hooks:   post-create ${runSummary(r.hooks)}`,
    ...r.warnings.map((w) => `warning: ${w}`),
  ].join('\n');
}
```

`src/cli.js` — import `runRefresh` from `./commands/refresh.js` and `formatRefresh` from `./lib/format.js`; register after `create`:
```js
  withGlobals(program.command('refresh'))
    .description("Rewrite a lane's local files and .laines.env, then run post-create again (recovers a setup-failed lane)")
    .argument('[lane]', 'lane name (default: the lane you are in)')
    .option('--dry-run', 'show which hooks would run without changing anything')
    .action(handle(runRefresh, { table: formatRefresh, args: ['lane'] }, deps));
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/refresh.test.js` → PASS. Then `npm run test:run` and `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/commands/refresh.js src/cli.js src/lib/format.js test/refresh.test.js
git commit -m "feat: laines refresh rewrites lane files and re-runs post-create

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `pre-teardown` and `post-teardown` in `teardown`

**Files:**
- Modify: `src/commands/teardown.js`, `src/lib/format.js`
- Test: `test/teardown.test.js`

**Interfaces:**
- Consumes: Task 1 (`listHooks`), Task 3 (`runEvent`, `dryRunHooks`, `hookBoardEntries`, `hookError`, `runSummary`, `putRequest`, `dropRequests`, `requestId`), Task 4 (`formatDryHooks`).
- Produces:
  - `runTeardown` result gains `hooks: HookRun[]` (pre and/or post that ran); dry run gains `hooks: dryRunHooks[]`.
  - A failing / exit-3 / refused `pre-teardown` throws `HookError` with nothing archived, deleted or closed (exit 3 and refusals add a `teardown-blocked:<lane>` request).
  - A failing `post-teardown` never fails the teardown: it adds a warning and a `cleanup-incomplete:<lane>` request; `laines teardown <lane>` on that closed lane re-runs only `post-teardown` and clears the request on success.
  - Second phase (`teardown <closed lane> --remove-dir`) writes a board activity line.

- [ ] **Step 1: Write the failing tests**

In `test/teardown.test.js`, extend imports: add `readdirSync` to the `node:fs` import, `HookError` to the errors import, and `writeHook, setConfig` to the helpers import. Append:
```js
describe('teardown hooks', () => {
  const requests = (s) => readLanes(loadContainer({ container: s.container }, s.deps)).requests;
  const board = (s) => readFileSync(join(s.container, '.ai', 'context', 'LANES_BOARD.md'), 'utf8');

  it('runs pre-teardown in the lane before anything is archived, and post-teardown in the container after', async () => {
    const s = await lane();
    writeFileSync(join(s.dir, '.ai', 'plans', 'task.md'), 'plan\n');
    writeHook(s.container, 'pre-teardown', 'test -f .ai/plans/task.md && echo "pre $LANE_NAME" >> "$CONTAINER_DIR/hooks.log"');
    writeHook(s.container, 'post-teardown', 'test ! -d "$LANE_DIR" && echo "post $(pwd -P)" >> "$CONTAINER_DIR/hooks.log"');
    const r = await runTeardown({ lane: 'lane_1', removeDir: true, container: s.container }, s.deps);
    expect(readFileSync(join(s.container, 'hooks.log'), 'utf8')).toBe(`pre lane_1\npost ${s.container}\n`);
    expect(r.hooks.map((h) => [h.event, h.outcome])).toEqual([['pre-teardown', 'ok'], ['post-teardown', 'ok']]);
  });

  it('reproduces per-lane database isolation purely with hooks (spec §14, criterion 4)', async () => {
    const s = await setupContainer();
    writeHook(s.container, 'post-create', 'mkdir -p "$CONTAINER_DIR/dbs" && touch "$CONTAINER_DIR/dbs/app$LANE_SUFFIX" && echo "DATABASE=app$LANE_SUFFIX" >> "$LANE_ENV_FILE"');
    writeHook(s.container, 'post-teardown', 'rm -f "$CONTAINER_DIR/dbs/app$LANE_SUFFIX"');
    await runCreate({ container: s.container }, s.deps);
    const two = await runCreate({ container: s.container }, s.deps);
    expect(readdirSync(join(s.container, 'dbs')).sort()).toEqual(['app_my_app_l1', 'app_my_app_l2']);
    expect(readFileSync(join(two.path, '.laines.env'), 'utf8')).toContain('DATABASE=app_my_app_l2');
    await runTeardown({ lane: 'lane_1', removeDir: true, container: s.container }, s.deps);
    expect(readdirSync(join(s.container, 'dbs'))).toEqual(['app_my_app_l2']);
  });

  it('a failing pre-teardown aborts with nothing touched', async () => {
    const s = await lane();
    writeFileSync(join(s.dir, '.ai', 'plans', 'task.md'), 'plan\n');
    writeHook(s.container, 'pre-teardown', 'echo "server still running" >&2; exit 1');
    const err = await runTeardown({ lane: 'lane_1', removeDir: true, container: s.container }, s.deps).catch((e) => e);
    expect(err).toBeInstanceOf(HookError);
    expect(err.exitCode).toBe(1);
    expect(err.message).toContain('server still running');
    expect(err.message).toContain('Teardown aborted: nothing was archived or deleted.');
    expect(state(s)).toMatchObject({ state: 'active' });
    expect(readFileSync(join(s.dir, '.ai', 'plans', 'task.md'), 'utf8')).toBe('plan\n');
    expect(board(s)).toContain('teardown aborted, nothing touched');
  });

  it('pre-teardown exit 3 asks a human and exits 3', async () => {
    const s = await lane();
    writeHook(s.container, 'pre-teardown', 'echo "stop the server first"; exit 3');
    const err = await runTeardown({ lane: 'lane_1', container: s.container }, s.deps).catch((e) => e);
    expect(err.exitCode).toBe(3);
    expect(requests(s).find((q) => q.id === 'teardown-blocked:lane_1')).toMatchObject({ command: 'laines teardown lane_1' });
    expect(state(s).state).toBe('active');
  });

  it('under policy approve an unapproved pre-teardown is refused and nothing is touched', async () => {
    const s = await lane();
    setConfig(s.container, (c) => { c.hooks.policy = 'approve'; });
    writeHook(s.container, 'pre-teardown', 'true');
    const err = await runTeardown({ lane: 'lane_1', container: s.container }, s.deps).catch((e) => e);
    expect(err.exitCode).toBe(3);
    expect(state(s).state).toBe('active');
    expect(requests(s).map((q) => q.id).sort()).toEqual(['hooks-changed:*', 'teardown-blocked:lane_1']);
    expect(requests(s).find((q) => q.id === 'teardown-blocked:lane_1').command).toBe('laines hooks approve && laines teardown lane_1');
  });

  it('a failing post-teardown closes the lane with a cleanup request, and teardown retries it', async () => {
    const s = await lane();
    writeHook(s.container, 'post-teardown', 'echo "dropdb failed" >&2; exit 1');
    const r = await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    expect(state(s).state).toBe('closed');
    expect(r.warnings.join('\n')).toMatch(/cleanup incomplete: post-teardown exited 1/);
    expect(requests(s).find((q) => q.id === 'cleanup-incomplete:lane_1')).toMatchObject({ command: 'laines teardown lane_1' });

    writeHook(s.container, 'post-teardown', 'touch "$CONTAINER_DIR/cleaned"');
    const retry = await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    expect(retry.hooks.map((h) => [h.event, h.outcome])).toEqual([['post-teardown', 'ok']]);
    expect(existsSync(join(s.container, 'cleaned'))).toBe(true);
    expect(requests(s).filter((q) => q.lane === 'lane_1')).toEqual([]);
    await expect(runTeardown({ lane: 'lane_1', container: s.container }, s.deps)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('skips pre-teardown when the clone is missing, and still runs post-teardown', async () => {
    const s = await lane();
    rmSync(s.dir, { recursive: true, force: true });
    writeHook(s.container, 'pre-teardown', 'exit 1');
    writeHook(s.container, 'post-teardown', 'touch "$CONTAINER_DIR/post-ran"');
    const r = await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    expect(r.warnings.join('\n')).toContain('pre-teardown skipped');
    expect(existsSync(join(s.container, 'post-ran'))).toBe(true);
    expect(state(s).state).toBe('closed');
  });

  it('dry run lists the hooks that would run and runs none', async () => {
    const s = await lane();
    writeHook(s.container, 'pre-teardown', 'touch "$CONTAINER_DIR/pre-ran"');
    writeHook(s.container, 'post-teardown', 'touch "$CONTAINER_DIR/post-ran"');
    const r = await runTeardown({ lane: 'lane_1', dryRun: true, container: s.container }, s.deps);
    expect(r.hooks.map((h) => [h.event, h.wouldRun])).toEqual([['pre-teardown', true], ['post-teardown', true]]);
    expect(existsSync(join(s.container, 'pre-ran'))).toBe(false);
    expect(existsSync(join(s.container, 'post-ran'))).toBe(false);
  });

  it('logs the second phase of a two-step teardown on the board', async () => {
    const s = await lane();
    await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    await runTeardown({ lane: 'lane_1', removeDir: true, container: s.container }, s.deps);
    expect(board(s)).toContain('clone removed');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/teardown.test.js`
Expected: the new tests FAIL (hooks never run; no `hooks` in the result).

- [ ] **Step 3: Implement — replace `src/commands/teardown.js` with**

```js
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadContainer } from '../lib/container.js';
import { getLane, readLanes, updateLanes } from '../lib/lanes-store.js';
import { dropRequests, putRequest, requestId } from '../lib/lanes-state.js';
import { assertLaneDir, removeLaneDir } from '../lib/containment.js';
import { untrackedEntries } from '../lib/lane-files.js';
import { unpushedWork } from '../lib/lane-git.js';
import { listHooks } from '../lib/hooks.js';
import { dryRunHooks, hookBoardEntries, hookError, runEvent, runSummary, unapprovedWarnings } from '../lib/hook-events.js';
import { appendAudit } from '../lib/audit.js';
import { BlockedError, InvalidInputError } from '../lib/errors.js';

function archivePlans(ctx, deps, laneDir, name) {
  const entries = untrackedEntries(deps, laneDir, '.ai/plans');
  if (!entries.length) return null;
  const base = `${deps.now().slice(0, 10)}_${name}`;
  let dirName = base;
  for (let i = 2; existsSync(join(ctx.paths.ai, 'archive', dirName)); i += 1) dirName = `${base}-${i}`;
  const dest = join(ctx.paths.ai, 'archive', dirName, 'plans');
  mkdirSync(dest, { recursive: true });
  for (const entry of entries) renameSync(join(laneDir, '.ai', 'plans', entry), join(dest, entry));
  return `.ai/archive/${dirName}`;
}

function deleteContext(deps, laneDir) {
  const entries = untrackedEntries(deps, laneDir, '.ai/context');
  for (const entry of entries) rmSync(join(laneDir, '.ai', 'context', entry), { recursive: true, force: true });
  return entries.length > 0;
}

const keptMessage = (name, kept) =>
  `Lane ${name} is kept (${kept.reason}). A human must run \`laines release ${name}\` before it can be torn down.`;

// One locked board update for a hook run: its unapproved-hook notes, plus the caller's request and line.
const recordHookRun = (ctx, deps, run, name, finish) =>
  updateLanes(ctx, deps, (s) => {
    const ts = deps.now();
    const board = hookBoardEntries(run, { lane: name, now: ts });
    const { state, text } = finish(board.requests.reduce(putRequest, s), ts);
    return { state, result: null, activity: [...board.activity, { ts, lane: name, text }] };
  });

// Human-only (deny rules in agent settings): the lane must always be named.
export async function runTeardown(opts, deps) {
  if (!opts.lane) throw new InvalidInputError('Name the lane to tear down: `laines teardown <lane>`.');
  const ctx = loadContainer(opts, deps);
  const name = opts.lane;
  const before = readLanes(ctx);
  const lane = getLane(before, name);
  if (!lane) throw new InvalidInputError(`No lane named ${name}. See \`laines list --all\`.`);
  if (lane.kept) {
    throw new BlockedError(keptMessage(name, lane.kept));
  }
  const closed = lane.state === 'closed';
  const cleanupId = requestId('cleanup-incomplete', name);
  const cleanupPending = before.requests.some((q) => q.id === cleanupId);
  if (closed && !opts.removeDir && !cleanupPending) {
    throw new InvalidInputError(`Lane ${name} is already closed. Pass --remove-dir to delete its clone.`);
  }
  const laneDir = join(ctx.root, lane.repos[0].path);
  const real = assertLaneDir(ctx.root, laneDir, lane.repos[0].path);
  const isRepo = Boolean(real) && existsSync(join(real, '.git'));
  // A directory that is not a repository cannot be proven safe to delete: refuse unless --force.
  const unverifiable = { dirty: [], stashes: 0, unpushed: 0, refs: [], noUpstream: null, problems: ['not a git repository: unpushed work cannot be verified'] };
  let checks = null;
  if (opts.removeDir && real) checks = isRepo ? unpushedWork(deps, real) : unverifiable;
  const risky = Boolean(checks && checks.problems.length);
  const blocked = risky && !opts.force;
  const warnings = checks?.noUpstream ? [`branch ${checks.noUpstream} has no upstream`] : [];
  // A first teardown runs pre-teardown (when the clone exists) and post-teardown. Tearing down a
  // closed lane again re-runs only a post-teardown that failed last time.
  const runPre = !closed && Boolean(real);
  const runPost = !closed || cleanupPending;

  if (opts.dryRun) {
    const hooks = [...(runPre ? [dryRunHooks(ctx, 'pre-teardown')] : []), ...(runPost ? [dryRunHooks(ctx, 'post-teardown')] : [])];
    return { dryRun: true, lane: name, path: laneDir, blocked, removedDir: Boolean(opts.removeDir && real), forced: risky && Boolean(opts.force), checks, warnings, hooks };
  }
  if (blocked) {
    throw new BlockedError([
      `Refusing to remove ${laneDir}:`,
      ...checks.problems.map((p) => `  - ${p}`),
      isRepo
        ? `Push the work, or save it first: git -C ${laneDir} bundle create <file> --all --not --remotes`
        : `Copy anything you need out of ${laneDir} first.`,
      'Nothing has been archived or deleted. Use --force only after confirming this work can be lost.',
    ].join('\n'));
  }

  // Spec §10.3 step 4: pre-teardown runs after the safety checks and before anything is touched.
  let pre = null;
  if (runPre) {
    // Narrow the window for a `keep` landing during the checks: the hook may have side effects.
    // The under-lock re-check below still decides; the lock is never held while a hook runs.
    const fresh = getLane(readLanes(ctx), name);
    if (fresh?.kept) throw new BlockedError(keptMessage(name, fresh.kept));
    pre = await runEvent(ctx, deps, { event: 'pre-teardown', name, lane, cwd: real });
    if (pre.outcome !== 'ok') {
      await recordHookRun(ctx, deps, pre, name, (state, ts) => ({
        state: pre.outcome === 'failed'
          ? state
          : putRequest(state, {
            ts,
            lane: name,
            kind: 'teardown-blocked',
            text: `teardown stopped: pre-teardown ${runSummary(pre)}`,
            command: `${pre.outcome === 'refused' ? 'laines hooks approve && ' : ''}laines teardown ${name}${opts.removeDir ? ' --remove-dir' : ''}`,
          }),
        text: `teardown aborted, nothing touched: pre-teardown ${runSummary(pre)}`,
      }));
      throw hookError(pre, 'Teardown aborted: nothing was archived or deleted.');
    }
    warnings.push(...unapprovedWarnings(pre));
  } else if (!closed && listHooks(ctx.paths.hooks, 'pre-teardown').length) {
    warnings.push(`pre-teardown skipped: ${laneDir} does not exist`);
  }

  const now = deps.now();
  let archivedTo = null;
  let contextDeleted = false;
  if (!closed) {
    // Re-checked under the lock: a `keep` that landed during the git checks must win, and the
    // archive/delete happen only once the record is known to be closable.
    await updateLanes(ctx, deps, (s) => {
      const board = pre ? hookBoardEntries(pre, { lane: name, now }) : { activity: [], requests: [] };
      const state = board.requests.reduce(putRequest, s);
      const l = getLane(state, name);
      if (!l) throw new InvalidInputError(`Lane ${name} no longer exists.`);
      if (l.kept) throw new BlockedError(keptMessage(name, l.kept));
      if (real) {
        archivedTo = archivePlans(ctx, deps, real, name);
        contextDeleted = deleteContext(deps, real);
      }
      l.state = 'closed';
      l.status = 'closed';
      l.blocked = null;
      l.closed = now;
      l.updated = now;
      state.requests = state.requests.filter((q) => q.lane !== name);
      const note = archivedTo ? `plans archived to ${archivedTo}` : 'no plans to archive';
      return { state, result: null, activity: [...board.activity, { ts: now, lane: name, text: `lane torn down; ${note}` }] };
    });
  } else if (opts.removeDir && real) {
    // Second phase of a two-step teardown: anything written since the close is archived too.
    archivedTo = archivePlans(ctx, deps, real, name);
    contextDeleted = deleteContext(deps, real);
  }
  const removedDir = opts.removeDir ? removeLaneDir(ctx.root, laneDir, lane.repos[0].path) : false;
  if (closed && opts.removeDir) {
    const text = removedDir ? `clone removed${archivedTo ? `; plans archived to ${archivedTo}` : ''}` : 'no clone left to remove';
    await updateLanes(ctx, deps, (state) => ({ state, result: null, activity: [{ ts: deps.now(), lane: name, text }] }));
  }

  // Spec §10.3 step 7: post-teardown runs in the container; a failure leaves a request, never an error.
  let post = null;
  if (runPost) {
    post = await runEvent(ctx, deps, { event: 'post-teardown', name, lane, cwd: ctx.root });
    const ok = post.outcome === 'ok';
    warnings.push(...unapprovedWarnings(post));
    if (!ok) warnings.push(`cleanup incomplete: post-teardown ${runSummary(post)}. Fix it, then run \`laines teardown ${name}\` to retry.`);
    if (!ok || post.results.length || cleanupPending) {
      await recordHookRun(ctx, deps, post, name, (state, ts) => ({
        state: ok
          ? dropRequests(state, (q) => q.id === cleanupId)
          : putRequest(state, { ts, lane: name, kind: 'cleanup-incomplete', text: `cleanup incomplete: post-teardown ${runSummary(post)}`, command: `laines teardown ${name}` }),
        text: ok ? `post-teardown: ${runSummary(post)}` : `cleanup incomplete: post-teardown ${runSummary(post)}`,
      }));
    }
  }
  const forced = risky && Boolean(opts.force);
  appendAudit(
    ctx.paths.audit,
    { ts: now, action: 'teardown', container: ctx.id, lane: name, removedDir, forced, hooks: { pre: pre?.outcome ?? null, post: post?.outcome ?? null } },
    { warn: deps.warn },
  );
  return { dryRun: false, lane: name, path: laneDir, archivedTo, contextDeleted, removedDir, forced, checks, warnings, hooks: [pre, post].filter(Boolean) };
}
```

`src/lib/format.js` — replace `formatTeardown` with:
```js
export function formatTeardown(r) {
  if (r.dryRun) {
    const lines = [`dry run: ${r.blocked ? 'teardown would be refused' : `would tear down ${r.lane}`}`];
    for (const p of r.checks?.problems ?? []) lines.push(`  - ${p}`);
    if (r.removedDir) lines.push(`would remove ${r.path}`);
    for (const h of r.hooks ?? []) lines.push(formatDryHooks(h));
    return lines.join('\n');
  }
  const lines = [`${r.lane} torn down`];
  lines.push(r.archivedTo ? `plans archived to ${r.archivedTo}` : 'no plans to archive');
  if (r.removedDir) lines.push(`removed ${r.path}${r.forced ? ' (forced)' : ''}`);
  else lines.push(`clone left at ${r.path}`);
  for (const h of r.hooks ?? []) lines.push(`hooks:   ${h.event} ${runSummary(h)}`);
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  return lines.join('\n');
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/teardown.test.js` → PASS (old and new). Then `npm run test:run` and `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/commands/teardown.js src/lib/format.js test/teardown.test.js
git commit -m "feat: run pre-teardown and post-teardown hooks, with cleanup retry

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `hooks status`, `hooks approve`, `hooks policy`

**Files:**
- Create: `src/commands/hooks.js`
- Modify: `src/config.js` (`saveConfig`), `src/cli.js`, `src/lib/format.js`
- Test: `test/hooks-commands.test.js`

**Interfaces:**
- Consumes: Task 1 (`hookStates`, `approveHooks`, `hookDiff`, `isExecutable`), Task 3 (`lockSuggested`, `dropRequests`), `updateLanes`, `appendAudit`.
- Produces:
  - `saveConfig(file, config)` — validates with `ConfigSchema`, writes atomically.
  - `runHooksStatus(opts, deps) → { policy, hooks: [{ hook, event, state, checksum, approved, executable, diff? }], removed, lockSuggested }` (read-only)
  - `runHooksApprove({ lock?, dryRun? }, deps)` → dry run `{ dryRun: true, approve: [{ hook, state, checksum }], removed, lock }`; else `{ dryRun: false, approved: [{ hook, checksum, was }], removed, policy }`. Clears `hooks-changed` (and with `--lock`, `hooks-lock`) requests; audits `hooks-approve`.
  - `runHooksPolicy({ policy, dryRun? }, deps)` → `{ dryRun, from, to, changed }`. Audits `hooks-policy`; any change clears `hooks-lock`.
  - CLI: `laines hooks status`, `laines hooks approve [--lock] [--dry-run]`, `laines hooks policy <approve|notify|open> [--dry-run]`; `formatHooksStatus`, `formatHooksApprove`, `formatHooksPolicy`.

- [ ] **Step 1: Write the failing test**

`test/hooks-commands.test.js`:
```js
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCreate } from '../src/commands/create.js';
import { runHooksApprove, runHooksPolicy, runHooksStatus } from '../src/commands/hooks.js';
import { loadContainer } from '../src/lib/container.js';
import { readLanes } from '../src/lib/lanes-store.js';
import { InvalidInputError } from '../src/lib/errors.js';
import { cleanupTmp, setupContainer, runCli, writeHook, setConfig } from './helpers.js';

afterEach(cleanupTmp);

const ctxOf = (s) => loadContainer({ container: s.container }, s.deps);
const config = (s) => JSON.parse(readFileSync(join(s.container, '.laines', 'config.json'), 'utf8'));

describe('hooks status', () => {
  it('reports each hook with its state, diff and executable bit', async () => {
    const s = await setupContainer();
    writeHook(s.container, 'post-create', 'echo one');
    writeHook(s.container, 'pre-teardown', 'echo two', { mode: 0o644 });
    const r = await runHooksStatus({ container: s.container }, s.deps);
    expect(r).toMatchObject({ policy: 'notify', removed: [], lockSuggested: false });
    expect(r.hooks.map((h) => [h.hook, h.event, h.state, h.executable])).toEqual([['post-create', 'post-create', 'new', true], ['pre-teardown', 'pre-teardown', 'new', false]]);
    expect(r.hooks[0].diff).toContain('+echo one');
  });

  it('suggests a lock once creates have seen a stable hook set', async () => {
    const s = await setupContainer();
    setConfig(s.container, (c) => { c.hooks.stableAfter = 1; });
    writeHook(s.container, 'post-create', 'true');
    await runCreate({ container: s.container }, s.deps);
    expect((await runHooksStatus({ container: s.container }, s.deps)).lockSuggested).toBe(true);
  });
});

describe('hooks approve', () => {
  it('approves the current hooks, clears the approval request, and logs it', async () => {
    const s = await setupContainer();
    writeHook(s.container, 'post-create', 'true');
    await runCreate({ container: s.container }, s.deps);
    expect(readLanes(ctxOf(s)).requests.map((q) => q.id)).toContain('hooks-changed:*');
    const r = await runHooksApprove({ container: s.container }, s.deps);
    expect(r).toMatchObject({ dryRun: false, policy: 'notify', removed: [] });
    expect(r.approved).toEqual([{ hook: 'post-create', checksum: expect.stringMatching(/^sha256:/), was: 'new' }]);
    expect(readLanes(ctxOf(s)).requests).toEqual([]);
    expect((await runHooksStatus({ container: s.container }, s.deps)).hooks[0]).toMatchObject({ state: 'approved' });
    expect(readFileSync(ctxOf(s).paths.audit, 'utf8')).toContain('"action":"hooks-approve"');
    expect(readFileSync(ctxOf(s).paths.board, 'utf8')).toContain('hooks approved: post-create');
  });

  it('--lock also sets policy approve and clears the lock suggestion', async () => {
    const s = await setupContainer();
    setConfig(s.container, (c) => { c.hooks.stableAfter = 1; });
    writeHook(s.container, 'post-create', 'true');
    await runCreate({ container: s.container }, s.deps);
    expect(readLanes(ctxOf(s)).requests.map((q) => q.id)).toContain('hooks-lock:*');
    const r = await runHooksApprove({ lock: true, container: s.container }, s.deps);
    expect(r.policy).toBe('approve');
    expect(config(s).hooks.policy).toBe('approve');
    expect(readLanes(ctxOf(s)).requests).toEqual([]);
    expect(readFileSync(ctxOf(s).paths.board, 'utf8')).toContain('hook policy: approve');
  });

  it('dry run reports what would be approved and approves nothing', async () => {
    const s = await setupContainer();
    writeHook(s.container, 'post-create', 'true');
    const r = await runHooksApprove({ dryRun: true, lock: true, container: s.container }, s.deps);
    expect(r).toMatchObject({ dryRun: true, lock: true, approve: [{ hook: 'post-create', state: 'new' }] });
    expect((await runHooksStatus({ container: s.container }, s.deps)).hooks[0].state).toBe('new');
    expect(config(s).hooks.policy).toBe('notify');
  });
});

describe('hooks policy', () => {
  it('changes the policy, re-renders the board header and audits the change', async () => {
    const s = await setupContainer();
    const r = await runHooksPolicy({ policy: 'open', container: s.container }, s.deps);
    expect(r).toEqual({ dryRun: false, from: 'notify', to: 'open', changed: true });
    expect(config(s).hooks.policy).toBe('open');
    expect(readFileSync(ctxOf(s).paths.board, 'utf8')).toContain('hook policy: open');
    expect(readFileSync(ctxOf(s).paths.audit, 'utf8')).toContain('"action":"hooks-policy"');
  });

  it('rejects an unknown policy, and does nothing when unchanged or on a dry run', async () => {
    const s = await setupContainer();
    await expect(runHooksPolicy({ policy: 'yolo', container: s.container }, s.deps)).rejects.toBeInstanceOf(InvalidInputError);
    expect(await runHooksPolicy({ policy: 'notify', container: s.container }, s.deps)).toMatchObject({ changed: false });
    expect(await runHooksPolicy({ policy: 'approve', dryRun: true, container: s.container }, s.deps)).toEqual({ dryRun: true, from: 'notify', to: 'approve', changed: true });
    expect(config(s).hooks.policy).toBe('notify');
    expect(readFileSync(ctxOf(s).paths.audit, 'utf8')).not.toContain('hooks-policy');
  });
});

describe('hooks CLI', () => {
  it('wires status, approve and policy, and rejects options placed before the subcommand', async () => {
    const s = await setupContainer();
    const status = await runCli(['hooks', 'status', '--container', s.container], s.deps);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ policy: 'notify', hooks: [] });
    const bypass = await runCli(['hooks', '--format', 'json', 'policy', 'open', '--container', s.container], s.deps);
    expect(bypass.code).toBe(2);
    expect(config(s).hooks.policy).toBe('notify');
    const set = await runCli(['hooks', 'policy', 'open', '--container', s.container, '--format', 'table'], s.deps);
    expect(set.code).toBe(0);
    expect(set.stdout).toContain('hook policy notify → open');
    const approve = await runCli(['hooks', 'approve', '--container', s.container, '--format', 'table'], s.deps);
    expect(approve.code).toBe(0);
    expect(approve.stdout).toContain('approved 0 hook(s)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/hooks-commands.test.js`
Expected: FAIL — cannot resolve `../src/commands/hooks.js`.

- [ ] **Step 3: Implement**

`src/config.js` — add `import { writeJson } from './lib/jsonfile.js';` (merge with the existing `readJson` import) and append:
```js
// Validates before writing, so a bad value never reaches disk.
export function saveConfig(file, config) {
  writeJson(file, parseWith(ConfigSchema, config, file));
}
```

`src/commands/hooks.js`:
```js
import { loadContainer } from '../lib/container.js';
import { readLanes, updateLanes } from '../lib/lanes-store.js';
import { dropRequests } from '../lib/lanes-state.js';
import { approveHooks, hookDiff, hookStates, isExecutable } from '../lib/hooks.js';
import { lockSuggested } from '../lib/hook-events.js';
import { saveConfig } from '../config.js';
import { appendAudit } from '../lib/audit.js';
import { InvalidInputError } from '../lib/errors.js';

const POLICIES = ['approve', 'notify', 'open'];

// Mutates ctx.config too, so the board rendered afterwards shows the new policy.
function setPolicy(ctx, policy) {
  ctx.config = { ...ctx.config, hooks: { ...ctx.config.hooks, policy } };
  saveConfig(ctx.paths.config, ctx.config);
}

export async function runHooksStatus(opts, deps) {
  const ctx = loadContainer(opts, deps);
  const { hooks, removed } = hookStates(ctx.paths);
  const current = Object.fromEntries(hooks.map((h) => [h.rel, h.checksum]));
  return {
    policy: ctx.config.hooks.policy,
    hooks: hooks.map((h) => ({
      hook: h.rel,
      event: h.event,
      state: h.state,
      checksum: h.checksum,
      approved: h.approved,
      executable: isExecutable(h.path),
      ...(h.state === 'approved' ? {} : { diff: hookDiff(deps, ctx.paths, h) }),
    })),
    removed,
    lockSuggested: lockSuggested(readLanes(ctx), ctx.config, current),
  };
}

// Human-only (deny rules in agent settings).
export async function runHooksApprove(opts, deps) {
  const ctx = loadContainer(opts, deps);
  if (opts.dryRun) {
    const { hooks, removed } = hookStates(ctx.paths);
    return { dryRun: true, approve: hooks.filter((h) => h.state !== 'approved').map((h) => ({ hook: h.rel, state: h.state, checksum: h.checksum })), removed, lock: Boolean(opts.lock) };
  }
  const { approved, removed } = approveHooks(ctx.paths);
  if (opts.lock) setPolicy(ctx, 'approve');
  const now = deps.now();
  const list = approved.map((h) => h.rel).join(', ') || 'none';
  await updateLanes(ctx, deps, (s) => ({
    state: dropRequests(s, (q) => q.kind === 'hooks-changed' || (opts.lock && q.kind === 'hooks-lock')),
    result: null,
    activity: [{ ts: now, lane: null, text: `hooks approved: ${list}${opts.lock ? '; hook policy set to approve' : ''}` }],
  }));
  appendAudit(
    ctx.paths.audit,
    { ts: now, action: 'hooks-approve', container: ctx.id, hooks: Object.fromEntries(approved.map((h) => [h.rel, h.checksum])), lock: Boolean(opts.lock) },
    { warn: deps.warn },
  );
  return { dryRun: false, approved: approved.map((h) => ({ hook: h.rel, checksum: h.checksum, was: h.state })), removed, policy: ctx.config.hooks.policy };
}

// Human-only (deny rules in agent settings).
export async function runHooksPolicy(opts, deps) {
  const to = opts.policy;
  if (!POLICIES.includes(to)) throw new InvalidInputError(`Hook policy must be one of: ${POLICIES.join(', ')} (got "${to}").`);
  const ctx = loadContainer(opts, deps);
  const from = ctx.config.hooks.policy;
  const changed = from !== to;
  if (opts.dryRun || !changed) return { dryRun: Boolean(opts.dryRun), from, to, changed };
  setPolicy(ctx, to);
  const now = deps.now();
  await updateLanes(ctx, deps, (s) => ({
    // Any policy change settles the lock suggestion: `approve` fulfils it, others decline it.
    state: dropRequests(s, (q) => q.kind === 'hooks-lock'),
    result: null,
    activity: [{ ts: now, lane: null, text: `hook policy changed: ${from} → ${to}` }],
  }));
  appendAudit(ctx.paths.audit, { ts: now, action: 'hooks-policy', container: ctx.id, from, to }, { warn: deps.warn });
  return { dryRun: false, from, to, changed };
}
```

`src/lib/format.js` — add:
```js
export function formatHooksStatus(r) {
  const lines = [`policy: ${r.policy}`];
  if (!r.hooks.length && !r.removed.length) lines.push('no hooks');
  for (const h of r.hooks) lines.push(`${h.state.padEnd(9)} ${h.hook}${h.executable ? '' : ' (not executable)'}`);
  for (const rel of r.removed) lines.push(`${'removed'.padEnd(9)} ${rel}`);
  if (r.lockSuggested) lines.push('', 'hooks are stable: a human can lock them with `laines hooks approve --lock`');
  for (const h of r.hooks.filter((x) => x.diff)) lines.push('', `--- ${h.hook} (${h.state}) ---`, h.diff.trimEnd());
  return lines.join('\n');
}

export function formatHooksApprove(r) {
  if (r.dryRun) {
    return [`dry run: would approve ${r.approve.length} hook(s)${r.lock ? ' and set hook policy approve' : ''}`, ...r.approve.map((h) => `  ${h.hook} (${h.state})`)].join('\n');
  }
  return [
    `approved ${r.approved.length} hook(s); hook policy ${r.policy}`,
    ...r.approved.map((h) => `  ${h.hook} ${h.checksum}${h.was === 'approved' ? '' : ` (was ${h.was})`}`),
    ...r.removed.map((rel) => `  dropped ${rel} (no longer present)`),
  ].join('\n');
}

export const formatHooksPolicy = (r) =>
  r.dryRun ? `dry run: hook policy ${r.from} → ${r.to}` : r.changed ? `hook policy ${r.from} → ${r.to}` : `hook policy already ${r.to}`;
```

`src/cli.js` — import `runHooksStatus, runHooksApprove, runHooksPolicy` from `./commands/hooks.js` and the three formatters; register after `teardown`:
```js
  // The group itself takes no options: `laines hooks --format json approve` must stay a usage error
  // so it cannot slip past the `Bash(laines hooks approve:*)` deny rule.
  const hooks = program.command('hooks').description('Review, approve and set the policy for lane hooks');
  withGlobals(hooks.command('status'))
    .description('List hooks as approved, changed or new, with diffs against the approved copies')
    .action(handle(runHooksStatus, { table: formatHooksStatus }, deps));
  withGlobals(hooks.command('approve'))
    .description('Approve the current hooks (human-only)')
    .option('--lock', 'also set hook policy "approve", so later changes are refused until approved')
    .option('--dry-run', 'show what would be approved without changing anything')
    .action(handle(runHooksApprove, { table: formatHooksApprove }, deps));
  withGlobals(hooks.command('policy'))
    .description('Set the hook policy: approve, notify or open (human-only)')
    .argument('<policy>', 'approve | notify | open')
    .option('--dry-run', 'show the change without writing it')
    .action(handle(runHooksPolicy, { table: formatHooksPolicy, args: ['policy'] }, deps));
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/hooks-commands.test.js` → PASS. Then `npm run test:run` and `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/commands/hooks.js src/config.js src/cli.js src/lib/format.js test/hooks-commands.test.js
git commit -m "feat: laines hooks status, approve and policy

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `doctor` hook checks, templates, docs, carry-overs

**Files:**
- Modify: `src/commands/doctor.js`, `src/commands/init.js`, `src/lib/lane-files.js`, `templates/hooks-readme.md`, `templates/lane-management.md`, `README.md`, `.ai/plans/2026-09-29-laines-spec.md`, `.ai/plans/2026-09-29-laines-roadmap.md`, `.ai/notes/m2-carry-overs.md`, `.ai/notes/m1-deferred-findings.md`
- Test: `test/doctor.test.js`, `test/create.test.js`, `test/lanes-store.test.js`

**Interfaces:**
- Consumes: Task 1 (`hookStates`, `isExecutable`), Task 3 (`lockSuggested`), Task 4 (`create` with hooks).
- Produces: doctor check `hooks`; lane checks flag `setup-failed` and stale `spinning up`; `.ai/templates/lane-local-instructions.md` shipped by `init` and honoured by `writeLaneFiles`.

- [ ] **Step 1: Write the failing tests**

`test/doctor.test.js` — in the existing test `'passes every check on a fresh container'`, insert `'hooks'` between `'lanes-state'` and `'agent-reach'` in the expected check-name array. Add `writeHook, setConfig` to the helpers import, `import { loadContainer } from '../src/lib/container.js';`, `import { updateLanes } from '../src/lib/lanes-store.js';`, and append inside `describe('doctor', …)`:
```js
  it('reports hooks, and flags hooks that cannot run or will be refused', async () => {
    const s = await setupContainer();
    expect(byName(await runDoctor({ container: s.container }, s.deps)).hooks).toMatchObject({ ok: true, detail: 'policy notify; no hooks' });
    writeHook(s.container, 'post-create', 'true');
    expect(byName(await runDoctor({ container: s.container }, s.deps)).hooks).toMatchObject({ ok: true, detail: 'policy notify; 1 hook(s): 1 new' });
    writeHook(s.container, 'pre-teardown', 'true', { mode: 0o644 });
    const bad = byName(await runDoctor({ container: s.container }, s.deps)).hooks;
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain('not executable: pre-teardown');
    writeHook(s.container, 'pre-teardown', 'true');
    setConfig(s.container, (c) => { c.hooks.policy = 'approve'; });
    expect(byName(await runDoctor({ container: s.container }, s.deps)).hooks.detail).toContain('policy approve will refuse post-create, pre-teardown');
  });

  it('suggests a lock once the hook set is stable', async () => {
    const s = await setupContainer();
    setConfig(s.container, (c) => { c.hooks.stableAfter = 1; });
    writeHook(s.container, 'post-create', 'true');
    await runCreate({ container: s.container }, s.deps);
    expect(byName(await runDoctor({ container: s.container }, s.deps)).hooks.detail).toContain('laines hooks approve --lock');
  });

  it('flags a setup-failed lane and a create interrupted long ago', async () => {
    const s = await setupContainer();
    writeHook(s.container, 'post-create', 'exit 1');
    await runCreate({ container: s.container }, s.deps).catch(() => {});
    writeHook(s.container, 'post-create', 'true');
    await runCreate({ container: s.container }, s.deps);
    const ctx = loadContainer({ container: s.container }, s.deps);
    const setUpdated = (ts) => updateLanes(ctx, s.deps, (st) => {
      Object.assign(st.lanes.lane_2, { status: 'spinning up', updated: ts });
      return { state: st, result: null };
    });
    await setUpdated('2026-09-29T11:55:00.000Z');
    let r = byName(await runDoctor({ container: s.container }, s.deps));
    expect(r['lane:lane_1'].detail).toContain('setup failed: fix the hook, then run `laines refresh lane_1`');
    expect(r['lane:lane_2'].ok).toBe(true);
    await setUpdated('2026-09-29T10:00:00.000Z');
    r = byName(await runDoctor({ container: s.container }, s.deps));
    expect(r['lane:lane_2'].detail).toContain('create was interrupted');
    expect(r['lane:lane_2'].detail).toContain('laines teardown lane_2 --remove-dir --force');
  });
```

`test/create.test.js` — append inside `describe('create', …)`:
```js
  it('uses the container copy of lane-local-instructions.md when a team customises it', async () => {
    const { deps, container } = await setupContainer();
    const own = join(container, '.ai', 'templates', 'lane-local-instructions.md');
    expect(existsSync(own)).toBe(true);
    writeFileSync(own, 'Custom rules for {{lane}}\n');
    const r = await runCreate({ container }, deps);
    expect(readFileSync(join(r.path, 'CLAUDE.local.md'), 'utf8')).toBe('Custom rules for lane_1\n');
  });
```

`test/lanes-store.test.js` — append after the existing overflow test:
```js
  it('archives overflow oldest first when the log is already full', async () => {
    const root = tmp();
    const ctx = ctxFor(root, 10);
    const deps = testDeps(root);
    const at = (i) => ({ ts: `2026-09-29T12:${String(i).padStart(2, '0')}:00.000Z`, lane: null, text: `e${i}` });
    await updateLanes(ctx, deps, (s) => ({ state: s, result: null, activity: Array.from({ length: 10 }, (_, i) => at(i + 1)) }));
    await updateLanes(ctx, deps, (s) => ({ state: s, result: null, activity: [at(11), at(12), at(13)] }));
    const archived = readFileSync(join(ctx.paths.ai, 'archive', '2026-09-29_board-log.md'), 'utf8').split('\n').filter((l) => l.startsWith('- **'));
    expect(archived.map((l) => l.split(' · ')[1])).toEqual(['e1', 'e2', 'e3']);
    expect(readLanes(ctx).activity.map((a) => a.text)).toEqual(['e13', 'e12', 'e11', 'e10', 'e9', 'e8', 'e7', 'e6', 'e5', 'e4']);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/doctor.test.js test/create.test.js test/lanes-store.test.js`
Expected: the new doctor and template tests FAIL (the overflow test may already pass — it pins existing behaviour).

- [ ] **Step 3: Implement doctor**

`src/commands/doctor.js` — add imports:
```js
import { hookStates, isExecutable } from '../lib/hooks.js';
import { lockSuggested } from '../lib/hook-events.js';
```
Add above `runDoctor`:
```js
function laneStateProblems(name, lane, config, deps) {
  const problems = [];
  if (lane.state === 'setup-failed') problems.push(`setup failed: fix the hook, then run \`laines refresh ${name}\``);
  // A create in progress is "spinning up" too: only one older than a slow clone plus a full hook
  // timeout is treated as interrupted.
  const staleMs = ((config?.hooks.timeoutSec ?? 300) + 1800) * 1000;
  if (lane.status === 'spinning up' && Date.parse(deps.now()) - Date.parse(lane.updated) > staleMs) {
    problems.push(`create was interrupted (spinning up since ${lane.updated}): run \`laines teardown ${name} --remove-dir --force\`, then create it again`);
  }
  return problems;
}
```
In the lane loop, replace the `laneProblems(...)` line with:
```js
      const problems = [...laneStateProblems(name, lane, config, deps), ...laneProblems(root, marker?.id, name, lane, agents, deps)];
```
Right after the `lanes-state` check (before `const agents = …`), add:
```js
  check('hooks', () => {
    const policy = config ? config.hooks.policy : 'notify';
    const { hooks, removed } = hookStates(p);
    const problems = [];
    const stuck = hooks.filter((h) => !isExecutable(h.path)).map((h) => h.rel);
    if (stuck.length) problems.push(`not executable: ${stuck.join(', ')} (chmod +x)`);
    const unapproved = hooks.filter((h) => h.state !== 'approved').map((h) => h.rel);
    if (policy === 'approve' && unapproved.length) {
      problems.push(`policy approve will refuse ${unapproved.join(', ')} until a human runs \`laines hooks approve\``);
    }
    if (problems.length) throw new Error(problems.join('; '));
    const counts = ['approved', 'changed', 'new']
      .map((st) => [st, hooks.filter((h) => h.state === st).length])
      .filter(([, n]) => n)
      .map(([st, n]) => `${n} ${st}`);
    const parts = [`policy ${policy}`, hooks.length ? `${hooks.length} hook(s): ${counts.join(', ')}` : 'no hooks'];
    if (removed.length) parts.push(`approved but since removed: ${removed.join(', ')}`);
    const current = Object.fromEntries(hooks.map((h) => [h.rel, h.checksum]));
    if (config && lanesState && lockSuggested(lanesState, config, current)) {
      parts.push(`unchanged across the last ${config.hooks.stableAfter} creates: a human can lock them with \`laines hooks approve --lock\``);
    }
    return parts.join('; ');
  });
```

- [ ] **Step 4: Ship and honour the lane-local instructions template**

`src/commands/init.js` — add to `LANE_TEMPLATES`:
```js
  ['lane-local-instructions.md', 'Lane-local `CLAUDE.local.md` / `AGENTS.md` / `GEMINI.md`: lane identity and rules'],
```
`src/lib/lane-files.js` — in `writeLaneFiles`, replace
```js
  const local = renderTemplate(readTemplate('lane-local-instructions.md'), vars);
```
with
```js
  const local = template('lane-local-instructions.md');
```

- [ ] **Step 5: Templates**

Replace `templates/hooks-readme.md` with:
```md
# Hooks

Project-specific lane setup and cleanup. Each hook is an executable file named after its event,
optionally followed by executables in `<event>.d/`, run in name order. Files whose names start
with `.` are ignored.

| Hook | Runs | Working directory | On failure |
|---|---|---|---|
| `post-create` | after a lane is cloned and its files and `.laines.env` are written; again on `laines refresh <lane>` | lane | lane kept and marked `setup-failed`; fix the hook, then `laines refresh <lane>` |
| `pre-teardown` | before anything is archived or deleted | lane | teardown aborted, nothing touched |
| `post-teardown` | after the lane is closed (and its clone removed, with `--remove-dir`) | container | warning and a board request; `laines teardown <lane>` retries it |

Environment: `LANE_NAME`, `LANE_NUMBER`, `LANE_ID`, `LANE_DIR`, `CONTAINER_DIR`, `CONTAINER_ID`,
`LANE_PORT_BASE`, `LANE_PORT_COUNT`, `LANE_SUFFIX`, `LANE_BRANCH`, `LANE_ENV_FILE`, `PORT`,
`COMPOSE_PROJECT_NAME`, `LAINES_HOOK`, `LAINES_DRY_RUN`. Standard input is empty, so a hook cannot
prompt.

`post-create` may append variables to `$LANE_ENV_FILE`. `laines refresh` rewrites that file from
scratch and runs `post-create` again, so append unconditionally, and don't edit the file by hand.
Because it runs again, make `post-create` safe to repeat (for example `createdb … || true`).

Exit `0` for success, `3` when a human must act first (for example "start Postgres, then run
`laines refresh <lane>`"), anything else for failure. A hook that runs longer than
`hooks.timeoutSec` (default 300) is stopped, with everything it started. Output is captured and
shown to agents as untrusted.

Hook policy (`laines config get hooks.policy`): `notify` runs changed hooks and flags them on the
board; `approve` refuses changed hooks until a human runs `laines hooks approve`; `open` runs
hooks without checks. `laines hooks status` shows each hook's state and what changed. Once the
hooks are stable, a human locks them with `laines hooks approve --lock`.
```

In `templates/lane-management.md`, replace the whole `## Hooks` section (heading through the paragraph ending "`laines hooks approve --lock`.") with:
```md
## Hooks

Stack-specific setup lives in `.laines/hooks/` (`post-create`, `pre-teardown`, `post-teardown`).
See `.laines/hooks/README.md`.

- A lane whose `post-create` fails stays on disk, marked `setup-failed` on the board. Fix the hook
  (or what it needed), then run `laines refresh <lane>`: it rewrites the lane-local files and
  `.laines.env` and runs `post-create` again.
- `laines hooks status` lists each hook as approved, changed or new, with a diff.
- New containers run changed hooks and flag them on the board (policy `notify`). Once the hooks
  are stable, a human locks them with `laines hooks approve --lock`; from then on a changed hook
  is refused until a human approves it.
```

- [ ] **Step 6: README**

In `README.md`:
- Status line → `> **Status: pre-release.** Containers, lanes and hooks work today. The MCP server is being built. See [Roadmap](#roadmap). The package is not on npm yet; install from source.`
- `create` row: end the description with `…write the lane's env file, identity and deny rules, run the \`post-create\` hook, and print its brief. If the hook fails the lane is kept, marked \`setup-failed\`, and \`refresh\` retries it.`
- Add after the `create` row:
  `| \`laines refresh [lane] [--dry-run]\` | Rewrite a lane's local files and \`.laines.env\` from scratch, then run \`post-create\` again. Recovers a \`setup-failed\` lane. |`
- `teardown` row: append `Runs \`pre-teardown\` first (a failure aborts with nothing touched) and \`post-teardown\` last (a failure leaves a board request; running \`teardown\` again retries it).`
- Add after the `teardown` row:
  ```
  | `laines hooks status` | List each hook in `.laines/hooks/` as approved, changed or new, with a diff against the approved copy. |
  | `laines hooks approve [--lock] [--dry-run]` | Approve the current hooks (human-only). `--lock` also sets policy `approve`, so later changes are refused until a human approves them. |
  | `laines hooks policy <approve\|notify\|open> [--dry-run]` | Set the hook policy (human-only). |
  ```
- After the Isolation model paragraph that mentions hooks, add:
  ````md
  ### Example: a database per lane

  `.laines/hooks/post-create`:

  ```sh
  #!/bin/sh
  set -e
  # post-create runs again on `laines refresh`, so it must be safe to repeat.
  createdb "app$LANE_SUFFIX" 2>/dev/null || true
  echo "DATABASE_URL=postgres://localhost/app$LANE_SUFFIX" >> "$LANE_ENV_FILE"
  ```

  `.laines/hooks/post-teardown`:

  ```sh
  #!/bin/sh
  dropdb --if-exists "app$LANE_SUFFIX"
  ```

  Make both executable (`chmod +x`). A container's `.laines/hooks/README.md` documents the full
  contract.
  ````
- Roadmap: M3 status `✅ Done`.

- [ ] **Step 7: Spec, roadmap and notes**

- Spec §4 layout: after the `hooks.lock.json` line add `│   ├── hooks.approved/            # copies of the approved hooks (diffs for hooks status)`.
- Spec §8.2 table, `post-teardown` "On failure" cell → `warning + board request; \`teardown <lane>\` retries it`.
- Spec §8.3: after "Hooks may append to it." add: "`refresh` rewrites it from scratch before re-running `post-create`, so appended lines come back exactly once; hand edits are lost."
- Roadmap: M3 "Plan" cell → `2026-09-29-laines-m3-hooks-plan.md ✅ done`.
- `.ai/notes/m2-carry-overs.md`: delete the `## M3 (hooks, refresh)` section (all items are done or recorded as decisions in this plan), and add to the M5 section: `- Hooks never run under the container lock: a \`keep\` that lands while \`pre-teardown\` runs aborts the teardown only after the hook's side effects (teardown re-reads \`kept\` just before the hook to narrow the window).`
- `.ai/notes/m1-deferred-findings.md`: delete the `hooks-readme.md says \`laines refresh\` without \`<lane>\`` bullet.

- [ ] **Step 8: Run everything**

Run: `npm run test:run` → all pass. `npm run lint` → clean. Then a manual smoke run in a scratch directory (not the repo), with the real CLI:
```bash
S=$(mktemp -d) && git init -q --bare -b main "$S/app.git" && git clone -q "$S/app.git" "$S/seed" && git -C "$S/seed" commit -q --allow-empty -m init && git -C "$S/seed" push -q origin main
LAINES_CONFIG_DIR="$S/cfg" node bin/laines.js init "$S/lanes" --remote "$S/app.git" --format table
printf '#!/bin/sh\necho "DB=app$LANE_SUFFIX" >> "$LANE_ENV_FILE"\n' > "$S/lanes/.laines/hooks/post-create" && chmod +x "$S/lanes/.laines/hooks/post-create"
LAINES_CONFIG_DIR="$S/cfg" node bin/laines.js create --container "$S/lanes" --format table
LAINES_CONFIG_DIR="$S/cfg" node bin/laines.js hooks status --container "$S/lanes" --format table
LAINES_CONFIG_DIR="$S/cfg" node bin/laines.js doctor --container "$S/lanes" --format table
```
Expected: create prints `hooks:   post-create 1 hook(s) ran` and a warning that the hook ran unapproved; `hooks status` shows `new post-create` with a diff; `doctor` shows `✓ hooks — policy notify; 1 hook(s): 1 new`.

- [ ] **Step 9: Commit**

```bash
git add src/commands/doctor.js src/commands/init.js src/lib/lane-files.js templates/hooks-readme.md templates/lane-management.md README.md test/doctor.test.js test/create.test.js test/lanes-store.test.js .ai/plans/2026-09-29-laines-spec.md .ai/plans/2026-09-29-laines-roadmap.md .ai/notes/m2-carry-overs.md .ai/notes/m1-deferred-findings.md
git commit -m "feat: doctor hook checks; docs and templates for hooks and refresh

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
