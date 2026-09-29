# L.AI.nes M1 — Foundation + Container Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `laines` CLI whose `laines init <dir> --remote <url>` creates a working L.AI.nes container (bundled dot-ai layer, `.laines/` state, board, runbook, lane templates, agent instructions, Claude deny rules, machine-unique ID and port block), plus `laines config get` and `laines doctor [--prune]`.

**Architecture:** ESM Node package. `bin/laines.js` → `src/cli.js` (commander tree + single `handle()` wrapper that renders JSON/table and maps typed errors to exit codes) → `src/commands/*.js` (`runXxx(opts, deps)` returning plain data). Pure logic lives in `src/lib/*` (ids, ports, board renderer, templates) and small file-backed modules (JSON I/O, mkdir lock, machine index, config). External processes (dot-ai) and clock/env/home come in through `deps`.

**Tech Stack:** Node ≥ 20 (ESM), commander 12, zod 4, `@ajmarquez99/dot-ai` ^1.1.1 (invoked through its CLI), vitest 4, eslint 9.

**Spec:** `.ai/plans/2026-09-29-laines-spec.md` (roadmap: `.ai/plans/2026-09-29-laines-roadmap.md`; research: `.ai/knowledge/build-constraints.md`). Read the spec before starting.

## Global Constraints

- Node `>=20`, `"type": "module"`; package `@ajmarquez99/laines`; binary `laines`; `publishConfig.access: public`; MIT licence.
- Display name is `L.AI.nes` in prose and help text; machine identifiers are dot-free (`laines`, `.laines/`).
- Exit codes: `0` ok (incl. dry-run) · `1` unexpected/external failure · `2` user-fixable input or config · `3` blocked by a safety boundary or needs a human · `4` capability denied.
- JSON output by default; `--format table` opt-in. `--dry-run` is a true no-op: no file written, no index claim, no audit line, no dot-ai run.
- Commands never print or set `process.exitCode`; only `handle()` does.
- All JSON config/state files are read through `readJson` (malformed → `MalformedConfigError`, exit 2) and written atomically through `writeJson`.
- dot-ai is invoked only through its CLI binary resolved from our own `node_modules`, with `cwd` = the container. Never `require` its `src/`.
- L.AI.nes content in agent files sits after dot-ai's `<!-- END .ai-convention -->`, inside `<!-- BEGIN laines-lanes -->` / `<!-- END laines-lanes -->`.
- Machine index lives at `$LAINES_CONFIG_DIR`, else `$XDG_CONFIG_HOME/laines`, else `~/.config/laines`, file `containers.json`, lock dir `.lock`.
- Default machine port range 20000–29999; container block = `maxLanes × ports.stride` (default 20 × 10 = 200); lane N (1 ≤ N ≤ maxLanes) gets `block.start + (N − 1) × stride` … `+ stride − 1`.
- Public repository: no personal paths, emails, account names, or references to private material in any committed file or commit message. Test fixtures use `example.com` / temp dirs only.
- Tests never touch the real `~/.config`: every test sets `LAINES_CONFIG_DIR` (via `testDeps`) to a temp dir. Run tests with `npm run test:run` (never watch mode).
- Conventional commits (`feat:`, `test:`, `chore:`…). Stage files by explicit path, never `git add -A`.

## Review Focus

1. **Container IDs with hyphens** (`my-app`) must still yield identifier-safe DB/cache suffixes (`_my_app_l2`, no hyphen) — Task 4 pins `laneSuffix`.
2. **Running `init` on a directory that already has `.ai/` or `.laines/`, or sits inside another container, or is `/` or `$HOME`** must refuse with exit 2 and leave the machine index untouched — Task 10 pins all five.
3. **dot-ai failing part-way through `init`** must release the machine-index claim and tell the user which directory holds partial files — Task 10 pins it.
4. **Newlines or markdown in user-supplied board text** (task, blocked, reason) must not break the board's block structure — Task 7 pins `oneLine` sanitising.
5. **A pre-existing `.claude/settings.json`** with the user's own rules must be merged, not replaced; an invalid one must fail with exit 2 without being overwritten — Task 8 pins both.

---

## File structure (after M1)

```
package.json  package-lock.json  eslint.config.js  vitest.config.js
.gitignore  .gitattributes  LICENSE  README.md
bin/laines.js                      # argv → run()
src/version.js                     # VERSION from package.json
src/cli.js                         # commander tree, handle(), run()
src/deps.js                        # defaultDeps: env, homedir, cwd, now, runDotAi, warn
src/config.js                      # container config schema, buildConfig, loadConfig
src/lib/errors.js                  # EXIT_CODES + typed errors
src/lib/jsonfile.js                # readJson, writeJson (atomic), getPath
src/lib/schema.js                  # parseWith(schema, data, file)
src/lib/lock.js                    # withLock(lockDir, fn)
src/lib/paths.js                   # configDir(), containerPaths()
src/lib/ids.js                     # slugify, repoSlugFromRemote, uniqueId, validateId, laneSuffix, composeProject, laneId
src/lib/ports.js                   # allocateBlock, lanePorts
src/lib/machine-index.js           # loadIndex, claimContainer, releaseContainer, pruneIndex
src/lib/lanes-state.js             # lanes.json schema, emptyLanesState, addActivity
src/lib/board.js                   # renderBoard, oneLine, fmtTs
src/lib/templates.js               # readTemplate, renderTemplate
src/lib/agent-files.js             # AGENT_FLAGS/FILES, upsertBlock, denyRules, mergeDenyRules, addIndexRow, appendOnce
src/lib/dotai.js                   # dotAiBin, runDotAi
src/lib/audit.js                   # appendAudit
src/lib/container.js               # resolveContainer
src/lib/format.js                  # printJson + table formatters
src/commands/init.js               # runInit, parseAgents
src/commands/config.js             # runConfigGet
src/commands/doctor.js             # runDoctor
templates/                         # shipped content: lanes-block, runbook, lane READMEs, hooks README, context note
test/helpers.js                    # tmp dirs, testDeps
test/*.test.js
```

---

### Task 1: Package scaffold

**Files:**
- Create: `package.json`, `eslint.config.js`, `vitest.config.js`, `.gitignore`, `.gitattributes`, `LICENSE`, `README.md`, `bin/laines.js`, `src/version.js`, `src/cli.js`
- Test: `test/smoke.test.js`

**Interfaces:**
- Produces: `VERSION: string` from `src/version.js`; `buildProgram(deps?) → Command` and `run(argv, deps?) → Promise<void>` from `src/cli.js` (Task 11 extends both).

- [ ] **Step 1: Create a working branch**

```bash
git checkout -b feat/m1-foundation
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "@ajmarquez99/laines",
  "version": "0.1.0",
  "type": "module",
  "description": "L.AI.nes: isolated parallel work lanes for coding agents. One shared .ai/ knowledge base, many independent clones, each with its own local environment.",
  "bin": {
    "laines": "./bin/laines.js"
  },
  "files": [
    "bin/",
    "src/",
    "templates/",
    "README.md",
    "LICENSE"
  ],
  "engines": {
    "node": ">=20"
  },
  "license": "MIT",
  "author": "Alejandro Marquez",
  "repository": {
    "type": "git",
    "url": "https://github.com/AJMarquez99/laines.git"
  },
  "homepage": "https://github.com/AJMarquez99/laines#readme",
  "bugs": {
    "url": "https://github.com/AJMarquez99/laines/issues"
  },
  "keywords": ["ai", "agents", "claude", "parallel", "lanes", "git", "cli", "mcp"],
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "test": "vitest",
    "test:run": "vitest run",
    "lint": "eslint .",
    "prepublishOnly": "npm run test:run"
  },
  "dependencies": {
    "@ajmarquez99/dot-ai": "^1.1.1",
    "commander": "^12.1.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@eslint/js": "^9.16.0",
    "eslint": "^9.16.0",
    "globals": "^15.13.0",
    "vitest": "^4.1.8"
  }
}
```

- [ ] **Step 3: Write tooling config files**

`eslint.config.js`:
```js
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'coverage/**', 'reference/**'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', args: 'after-used', caughtErrors: 'none' }],
    },
  },
];
```

`vitest.config.js`:
```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    testTimeout: 30000,
  },
});
```

`.gitignore`:
```
node_modules/
coverage/
*.log
.DS_Store
```

`.gitattributes`:
```
* text=auto eol=lf
bin/* text eol=lf
*.sh text eol=lf
```

`LICENSE`:
```
MIT License

Copyright (c) 2026 Alejandro Marquez

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

`README.md` (placeholder until M5 writes the real one):
```markdown
# L.AI.nes

Isolated parallel work lanes for coding agents: one shared `.ai/` knowledge base, many
independent clones of your project, each with its own local environment.

Status: under active development (pre-release).
```

- [ ] **Step 4: Write the entry points**

`bin/laines.js`:
```js
#!/usr/bin/env node
import { run } from '../src/cli.js';

run(process.argv);
```

`src/version.js`:
```js
import { createRequire } from 'node:module';

// Single source of truth: the published package.json version.
const require = createRequire(import.meta.url);
export const VERSION = require('../package.json').version;
```

`src/cli.js`:
```js
import { Command } from 'commander';
import { VERSION } from './version.js';

export function buildProgram() {
  const program = new Command();
  program
    .name('laines')
    .description('L.AI.nes: isolated parallel work lanes for coding agents')
    .version(VERSION)
    .option('--format <format>', 'output format: json|table', 'json');
  return program;
}

export async function run(argv) {
  await buildProgram().parseAsync(argv);
}
```

Then:
```bash
chmod +x bin/laines.js
npm install
```
Expected: `node_modules/` and `package-lock.json` created, no errors.

- [ ] **Step 5: Write the smoke test**

`test/smoke.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { VERSION } from '../src/version.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const bin = new URL('../bin/laines.js', import.meta.url).pathname;

describe('package', () => {
  it('is ESM and declares the laines bin', () => {
    expect(pkg.type).toBe('module');
    expect(pkg.bin.laines).toBe('./bin/laines.js');
  });

  it('is publish-shaped', () => {
    expect(pkg.name).toBe('@ajmarquez99/laines');
    expect(pkg.files).toEqual(expect.arrayContaining(['bin/', 'src/', 'templates/', 'README.md', 'LICENSE']));
    expect(pkg.publishConfig).toEqual({ access: 'public' });
    expect(pkg.license).toBe('MIT');
    expect(pkg.engines.node).toBe('>=20');
  });

  it('single-sources the version', () => {
    expect(VERSION).toBe(pkg.version);
  });

  it('bin is executable and prints the version', () => {
    expect(statSync(bin).mode & 0o111).not.toBe(0);
    expect(execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim()).toBe(pkg.version);
  });
});
```

- [ ] **Step 6: Run tests and lint**

Run: `npm run test:run && npm run lint`
Expected: 4 tests pass; lint clean.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json eslint.config.js vitest.config.js .gitignore .gitattributes LICENSE README.md bin/laines.js src/version.js src/cli.js test/smoke.test.js
git commit -m "chore: scaffold laines package"
```

---

### Task 2: Errors, JSON I/O, schema parsing

**Files:**
- Create: `src/lib/errors.js`, `src/lib/jsonfile.js`, `src/lib/schema.js`, `test/helpers.js`
- Test: `test/errors.test.js`, `test/jsonfile.test.js`

**Interfaces:**
- Produces:
  - `EXIT_CODES = { OK: 0, GENERIC: 1, CONFIG: 2, BLOCKED: 3, CAPABILITY_DENIED: 4 }`
  - `class LainesError(message, exitCode = 1)`; subclasses `InvalidInputError(message)` (2), `MalformedConfigError(path, detail?)` (2, `.path`), `NotAContainerError(dir)` (2, `.dir`), `BlockedError(message)` (3), `LockTimeoutError(lockDir, timeoutMs)` (1, `.lockDir`)
  - `readJson(path, { onMissing? }) → any` (missing or empty file → `onMissing()` result, default `{}`)
  - `writeJson(path, obj) → void` (creates parent dirs; atomic temp + rename)
  - `getPath(obj, 'a.b') → any`
  - `parseWith(schema, data, file) → parsed` (zod failure → `MalformedConfigError(file, 'path: message; …')`)
  - `test/helpers.js`: `tmp() → string` (realpath'd temp dir), `cleanupTmp()`, `testDeps(root, overrides?)` (Task 10 adds `runDotAi`; define the full shape now)

- [ ] **Step 1: Write the failing tests**

`test/helpers.js`:
```js
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made = [];

export function tmp(prefix = 'laines-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

export function cleanupTmp() {
  while (made.length) rmSync(made.pop(), { recursive: true, force: true });
}

// Deps rooted in a temp dir: the machine index never touches the real ~/.config.
export function testDeps(root, overrides = {}) {
  return {
    env: { LAINES_CONFIG_DIR: join(root, 'config') },
    homedir: () => join(root, 'home'),
    cwd: () => root,
    now: () => '2026-09-29T12:00:00.000Z',
    runDotAi: () => {
      throw new Error('runDotAi not stubbed in this test');
    },
    warn: () => {},
    ...overrides,
  };
}
```

`test/errors.test.js`:
```js
import { describe, it, expect } from 'vitest';
import {
  EXIT_CODES, LainesError, InvalidInputError, MalformedConfigError, NotAContainerError, BlockedError, LockTimeoutError,
} from '../src/lib/errors.js';

describe('errors', () => {
  it('maps each error to its exit code', () => {
    expect(new LainesError('x').exitCode).toBe(EXIT_CODES.GENERIC);
    expect(new InvalidInputError('x').exitCode).toBe(2);
    expect(new MalformedConfigError('/a.json', 'bad').exitCode).toBe(2);
    expect(new NotAContainerError('/c').exitCode).toBe(2);
    expect(new BlockedError('x').exitCode).toBe(3);
    expect(new LockTimeoutError('/l', 5000).exitCode).toBe(1);
  });

  it('carries useful fields and names', () => {
    const e = new MalformedConfigError('/a.json', 'Unexpected token');
    expect(e.name).toBe('MalformedConfigError');
    expect(e.path).toBe('/a.json');
    expect(e.message).toContain('/a.json');
    expect(e.message).toContain('Unexpected token');
    expect(new LockTimeoutError('/l', 5000).message).toContain("rmdir '/l'");
    expect(new NotAContainerError('/c').message).toContain('laines init');
    expect(e).toBeInstanceOf(LainesError);
  });
});
```

`test/jsonfile.test.js`:
```js
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readJson, writeJson, getPath } from '../src/lib/jsonfile.js';
import { parseWith } from '../src/lib/schema.js';
import { MalformedConfigError } from '../src/lib/errors.js';
import { tmp, cleanupTmp } from './helpers.js';

afterEach(cleanupTmp);

describe('readJson', () => {
  it('returns onMissing() for a missing or blank file', () => {
    const d = tmp();
    expect(readJson(join(d, 'nope.json'))).toEqual({});
    writeFileSync(join(d, 'blank.json'), '  \n');
    expect(readJson(join(d, 'blank.json'), { onMissing: () => ({ a: 1 }) })).toEqual({ a: 1 });
  });

  it('throws MalformedConfigError for invalid JSON', () => {
    const d = tmp();
    writeFileSync(join(d, 'bad.json'), '{ nope');
    expect(() => readJson(join(d, 'bad.json'))).toThrow(MalformedConfigError);
  });
});

describe('writeJson', () => {
  it('creates parent dirs, pretty-prints with a trailing newline, leaves no temp files', () => {
    const d = tmp();
    const f = join(d, 'a', 'b', 'x.json');
    writeJson(f, { k: [1] });
    expect(readFileSync(f, 'utf8')).toBe('{\n  "k": [\n    1\n  ]\n}\n');
    expect(readdirSync(join(d, 'a', 'b'))).toEqual(['x.json']);
  });
});

describe('getPath', () => {
  it('reads dotted paths', () => {
    expect(getPath({ a: { b: 2 } }, 'a.b')).toBe(2);
    expect(getPath({ a: 1 }, 'a.b')).toBeUndefined();
  });
});

describe('parseWith', () => {
  it('returns parsed data or throws MalformedConfigError naming the field', () => {
    const s = z.strictObject({ n: z.number() });
    expect(parseWith(s, { n: 1 }, 'f.json')).toEqual({ n: 1 });
    try {
      parseWith(s, { n: 'x' }, 'f.json');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MalformedConfigError);
      expect(e.message).toContain('n:');
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:run -- test/errors.test.js test/jsonfile.test.js`
Expected: FAIL — cannot resolve `../src/lib/errors.js`.

- [ ] **Step 3: Implement**

`src/lib/errors.js`:
```js
// 0 ok · 1 unexpected/external · 2 user-fixable input or config · 3 blocked by a boundary / needs a human · 4 capability denied
export const EXIT_CODES = { OK: 0, GENERIC: 1, CONFIG: 2, BLOCKED: 3, CAPABILITY_DENIED: 4 };

export class LainesError extends Error {
  constructor(message, exitCode = EXIT_CODES.GENERIC) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}

export class InvalidInputError extends LainesError {
  constructor(message) {
    super(message, EXIT_CODES.CONFIG);
  }
}

export class MalformedConfigError extends LainesError {
  constructor(path, detail) {
    super(`Malformed file: ${path}${detail ? `\n  ${detail}` : ''}\nFix the file and retry.`, EXIT_CODES.CONFIG);
    this.path = path;
  }
}

export class NotAContainerError extends LainesError {
  constructor(dir) {
    super(
      `Not a L.AI.nes container: ${dir} (no .laines/container.json).\n` +
        'Run from the container directory, pass --container <dir>, or create one with `laines init`.',
      EXIT_CODES.CONFIG,
    );
    this.dir = dir;
  }
}

export class BlockedError extends LainesError {
  constructor(message) {
    super(message, EXIT_CODES.BLOCKED);
  }
}

export class LockTimeoutError extends LainesError {
  constructor(lockDir, timeoutMs) {
    super(
      `Could not acquire the lock ${lockDir} within ${Math.round(timeoutMs / 1000)}s.\n` +
        `If no other laines command is running, remove it: rmdir '${lockDir}'`,
      EXIT_CODES.GENERIC,
    );
    this.lockDir = lockDir;
  }
}
```

`src/lib/jsonfile.js`:
```js
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

export function getPath(obj, dotted) {
  let cur = obj;
  for (const key of dotted.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}
```

`src/lib/schema.js`:
```js
import { MalformedConfigError } from './errors.js';

export function parseWith(schema, data, file) {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const detail = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  throw new MalformedConfigError(file, detail);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:run -- test/errors.test.js test/jsonfile.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/errors.js src/lib/jsonfile.js src/lib/schema.js test/helpers.js test/errors.test.js test/jsonfile.test.js
git commit -m "feat: typed errors, atomic JSON I/O, schema parsing"
```

---

### Task 3: mkdir lock

**Files:**
- Create: `src/lib/lock.js`
- Test: `test/lock.test.js`

**Interfaces:**
- Consumes: `LockTimeoutError` (Task 2).
- Produces: `withLock(lockDir, fn, { timeoutMs = 5000, intervalMs = 100, sleep? }) → Promise<ReturnType<fn>>` — creates parent dirs, holds `lockDir` while `fn` runs, always removes it afterwards.

- [ ] **Step 1: Write the failing test**

`test/lock.test.js`:
```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- test/lock.test.js`
Expected: FAIL — cannot resolve `../src/lib/lock.js`.

- [ ] **Step 3: Implement**

`src/lib/lock.js`:
```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:run -- test/lock.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/lock.js test/lock.test.js
git commit -m "feat: mkdir-based lock"
```

---

### Task 4: Paths, IDs, ports

**Files:**
- Create: `src/lib/paths.js`, `src/lib/ids.js`, `src/lib/ports.js`
- Test: `test/ids-ports.test.js`

**Interfaces:**
- Consumes: `InvalidInputError`, `BlockedError` (Task 2).
- Produces:
  - `configDir(env, homedir) → string`
  - `containerPaths(root) → { root, laines, marker, config, lanes, hooks, hooksLock, audit, lock, ai, board, runbook, templatesDir, claudeSettings }`
  - `slugify(s) → string`, `repoSlugFromRemote(remote) → string`, `uniqueId(base, takenIds) → string`, `validateId(id) → id` (throws `InvalidInputError`)
  - `laneSuffix(id, n) → '_<id with - → _>_l<n>'`, `composeProject(id, n) → '<id>-l<n>'`, `laneId(id, lane) → '<id>/<lane>'`
  - `DEFAULT_MACHINE = { range: [20000, 29999], blockSize: 200 }`
  - `allocateBlock({ range, blockSize }, takenBlocks) → [start, end]` (throws `BlockedError` when full)
  - `lanePorts(block, n, stride) → [start, end]` (throws `InvalidInputError` when it doesn't fit)

- [ ] **Step 1: Write the failing test**

`test/ids-ports.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { configDir, containerPaths } from '../src/lib/paths.js';
import {
  slugify, repoSlugFromRemote, uniqueId, validateId, laneSuffix, composeProject, laneId,
} from '../src/lib/ids.js';
import { DEFAULT_MACHINE, allocateBlock, lanePorts } from '../src/lib/ports.js';
import { InvalidInputError, BlockedError } from '../src/lib/errors.js';

describe('configDir', () => {
  it('prefers LAINES_CONFIG_DIR, then XDG_CONFIG_HOME, then ~/.config', () => {
    expect(configDir({ LAINES_CONFIG_DIR: '/x' }, '/h')).toBe('/x');
    expect(configDir({ XDG_CONFIG_HOME: '/xdg' }, '/h')).toBe(join('/xdg', 'laines'));
    expect(configDir({}, '/h')).toBe(join('/h', '.config', 'laines'));
  });
});

describe('containerPaths', () => {
  it('lays out the container', () => {
    const p = containerPaths('/c');
    expect(p.marker).toBe('/c/.laines/container.json');
    expect(p.board).toBe('/c/.ai/context/LANES_BOARD.md');
    expect(p.claudeSettings).toBe('/c/.claude/settings.json');
    expect(p.lock).toBe('/c/.laines/.lock');
  });
});

describe('ids', () => {
  it('slugifies repo names from any remote form', () => {
    expect(repoSlugFromRemote('git@example.com:org/My.Repo.git')).toBe('my-repo');
    expect(repoSlugFromRemote('https://example.com/org/api/')).toBe('api');
    expect(repoSlugFromRemote('/tmp/fixtures/bare.git')).toBe('bare');
    expect(slugify('!!!')).toBe('container');
  });

  it('picks the next free id', () => {
    expect(uniqueId('app', [])).toBe('app');
    expect(uniqueId('app', ['app', 'app-2'])).toBe('app-3');
  });

  it('validates explicit ids', () => {
    expect(validateId('my-app2')).toBe('my-app2');
    expect(() => validateId('My App')).toThrow(InvalidInputError);
    expect(() => validateId('-x')).toThrow(InvalidInputError);
    expect(() => validateId('a'.repeat(33))).toThrow(InvalidInputError);
  });

  it('scopes per-lane names, with an identifier-safe suffix even for hyphenated ids', () => {
    expect(laneSuffix('my-app', 2)).toBe('_my_app_l2');
    expect(laneSuffix('my-app', 2)).toMatch(/^[a-z0-9_]+$/);
    expect(composeProject('my-app', 2)).toBe('my-app-l2');
    expect(laneId('my-app', 'lane_2')).toBe('my-app/lane_2');
  });
});

describe('ports', () => {
  it('allocates the first non-overlapping block', () => {
    expect(allocateBlock(DEFAULT_MACHINE, [])).toEqual([20000, 20199]);
    expect(allocateBlock(DEFAULT_MACHINE, [[20000, 20199]])).toEqual([20200, 20399]);
    expect(allocateBlock(DEFAULT_MACHINE, [[20200, 20399]])).toEqual([20000, 20199]);
    expect(allocateBlock(DEFAULT_MACHINE, [[20150, 20250]])).toEqual([20400, 20599]);
  });

  it('throws BlockedError when the range is full', () => {
    expect(() => allocateBlock({ range: [100, 299], blockSize: 100 }, [[100, 199], [200, 299]])).toThrow(BlockedError);
  });

  it('gives lane N its slice of the block, 1-based', () => {
    expect(lanePorts([20000, 20199], 1, 10)).toEqual([20000, 20009]);
    expect(lanePorts([20000, 20199], 20, 10)).toEqual([20190, 20199]);
    expect(() => lanePorts([20000, 20199], 21, 10)).toThrow(InvalidInputError);
    expect(() => lanePorts([20000, 20199], 0, 10)).toThrow(InvalidInputError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- test/ids-ports.test.js`
Expected: FAIL — cannot resolve `../src/lib/paths.js`.

- [ ] **Step 3: Implement**

`src/lib/paths.js`:
```js
import { join } from 'node:path';

export function configDir(env, homedir) {
  if (env.LAINES_CONFIG_DIR) return env.LAINES_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'laines');
  return join(homedir, '.config', 'laines');
}

export function containerPaths(root) {
  const laines = join(root, '.laines');
  const ai = join(root, '.ai');
  return {
    root,
    laines,
    marker: join(laines, 'container.json'),
    config: join(laines, 'config.json'),
    lanes: join(laines, 'lanes.json'),
    hooks: join(laines, 'hooks'),
    hooksLock: join(laines, 'hooks.lock.json'),
    audit: join(laines, 'audit.jsonl'),
    lock: join(laines, '.lock'),
    ai,
    board: join(ai, 'context', 'LANES_BOARD.md'),
    runbook: join(ai, 'runbooks', 'lane-management.md'),
    templatesDir: join(ai, 'templates'),
    claudeSettings: join(root, '.claude', 'settings.json'),
  };
}
```

`src/lib/ids.js`:
```js
import { InvalidInputError } from './errors.js';

export function slugify(s) {
  const slug = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return slug || 'container';
}

export function repoSlugFromRemote(remote) {
  const last = String(remote).replace(/\/+$/, '').split(/[/:]/).pop() || '';
  return slugify(last.replace(/\.git$/, ''));
}

export function uniqueId(base, takenIds) {
  const taken = new Set(takenIds);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function validateId(id) {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(id))) {
    throw new InvalidInputError(
      `Invalid container id "${id}": use lowercase letters, digits and hyphens, start with a letter or digit, max 32 characters.`,
    );
  }
  return id;
}

// Database/cache identifiers can't contain hyphens unquoted, so the suffix swaps them for underscores.
export const laneSuffix = (id, n) => `_${id.replace(/-/g, '_')}_l${n}`;
export const composeProject = (id, n) => `${id}-l${n}`;
export const laneId = (id, lane) => `${id}/${lane}`;
```

`src/lib/ports.js`:
```js
import { BlockedError, InvalidInputError } from './errors.js';

// Clear of common dev ports (3000/5000/8000) and of OS ephemeral ranges (32768+ Linux, 49152+ macOS).
export const DEFAULT_MACHINE = { range: [20000, 29999], blockSize: 200 };

export function allocateBlock({ range, blockSize }, takenBlocks) {
  for (let start = range[0]; start + blockSize - 1 <= range[1]; start += blockSize) {
    const end = start + blockSize - 1;
    if (!takenBlocks.some(([a, b]) => a <= end && start <= b)) return [start, end];
  }
  throw new BlockedError(
    `No free port block of ${blockSize} in ${range[0]}–${range[1]}.\n` +
      'Run `laines doctor --prune` to free blocks held by deleted containers, or widen machine.range in containers.json.',
  );
}

export function lanePorts(block, n, stride) {
  const start = block[0] + (n - 1) * stride;
  const end = start + stride - 1;
  if (!Number.isInteger(n) || n < 1 || end > block[1]) {
    throw new InvalidInputError(`Lane ${n} does not fit in port block ${block[0]}–${block[1]} with stride ${stride}.`);
  }
  return [start, end];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:run -- test/ids-ports.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/paths.js src/lib/ids.js src/lib/ports.js test/ids-ports.test.js
git commit -m "feat: config paths, container ids, port blocks"
```

---

### Task 5: Machine index

**Files:**
- Create: `src/lib/machine-index.js`
- Test: `test/machine-index.test.js`

**Interfaces:**
- Consumes: `readJson`, `writeJson` (Task 2); `parseWith` (Task 2); `withLock` (Task 3); `uniqueId`, `validateId`, `allocateBlock`, `DEFAULT_MACHINE` (Task 4); `InvalidInputError`.
- Produces:
  - `indexFiles(dir) → { file, lock }`
  - `emptyIndex() → { version: 1, machine: { range, blockSize }, containers: [] }`
  - `loadIndex(dir) → index` (missing → `emptyIndex()`)
  - `claimContainer(dir, { path, id?, baseId, blockSize?, now }) → Promise<{ id, path, portRange, created }>`
  - `releaseContainer(dir, id) → Promise<void>`
  - `pruneIndex(dir) → Promise<Entry[]>` (removes entries whose `path` has no `.laines/container.json`; returns removed)

- [ ] **Step 1: Write the failing test**

`test/machine-index.test.js`:
```js
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadIndex, claimContainer, releaseContainer, pruneIndex } from '../src/lib/machine-index.js';
import { InvalidInputError, MalformedConfigError } from '../src/lib/errors.js';
import { tmp, cleanupTmp } from './helpers.js';

afterEach(cleanupTmp);
const now = '2026-09-29T12:00:00.000Z';

describe('machine index', () => {
  it('starts empty with the default machine range', () => {
    const idx = loadIndex(join(tmp(), 'cfg'));
    expect(idx).toEqual({ version: 1, machine: { range: [20000, 29999], blockSize: 200 }, containers: [] });
  });

  it('claims unique ids and non-overlapping blocks, even in parallel', async () => {
    const dir = join(tmp(), 'cfg');
    const entries = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => claimContainer(dir, { path: `/c/${n}`, baseId: 'app', now })),
    );
    const ids = entries.map((e) => e.id).sort();
    expect(ids).toEqual(['app', 'app-2', 'app-3', 'app-4', 'app-5']);
    const blocks = entries.map((e) => e.portRange).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < blocks.length; i++) expect(blocks[i][0]).toBeGreaterThan(blocks[i - 1][1]);
    expect(loadIndex(dir).containers).toHaveLength(5);
  });

  it('honours an explicit id and refuses a taken one or a registered path', async () => {
    const dir = join(tmp(), 'cfg');
    const e = await claimContainer(dir, { path: '/c/a', id: 'web', baseId: 'app', now });
    expect(e.id).toBe('web');
    await expect(claimContainer(dir, { path: '/c/b', id: 'web', baseId: 'app', now })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(claimContainer(dir, { path: '/c/a', baseId: 'app', now })).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('uses a custom block size', async () => {
    const dir = join(tmp(), 'cfg');
    const e = await claimContainer(dir, { path: '/c/a', baseId: 'app', blockSize: 50, now });
    expect(e.portRange).toEqual([20000, 20049]);
  });

  it('releases and prunes', async () => {
    const root = tmp();
    const dir = join(root, 'cfg');
    const live = join(root, 'live');
    mkdirSync(join(live, '.laines'), { recursive: true });
    writeFileSync(join(live, '.laines', 'container.json'), '{}');
    await claimContainer(dir, { path: live, baseId: 'live', now });
    await claimContainer(dir, { path: join(root, 'gone'), baseId: 'gone', now });
    await claimContainer(dir, { path: join(root, 'x'), baseId: 'x', now });
    await releaseContainer(dir, 'x');
    const removed = await pruneIndex(dir);
    expect(removed.map((e) => e.id)).toEqual(['gone']);
    expect(loadIndex(dir).containers.map((e) => e.id)).toEqual(['live']);
  });

  it('rejects a malformed index with exit-2 error', () => {
    const dir = join(tmp(), 'cfg');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'containers.json'), JSON.stringify({ version: 1, containers: 'nope' }));
    expect(() => loadIndex(dir)).toThrow(MalformedConfigError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- test/machine-index.test.js`
Expected: FAIL — cannot resolve `../src/lib/machine-index.js`.

- [ ] **Step 3: Implement**

`src/lib/machine-index.js`:
```js
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readJson, writeJson } from './jsonfile.js';
import { parseWith } from './schema.js';
import { withLock } from './lock.js';
import { uniqueId, validateId } from './ids.js';
import { allocateBlock, DEFAULT_MACHINE } from './ports.js';
import { InvalidInputError } from './errors.js';

const Range = z.tuple([z.number().int(), z.number().int()]);

const IndexSchema = z.strictObject({
  version: z.literal(1),
  machine: z.strictObject({ range: Range, blockSize: z.number().int().positive() }),
  containers: z.array(
    z.strictObject({ id: z.string(), path: z.string(), portRange: Range, created: z.string() }),
  ),
});

export const indexFiles = (dir) => ({ file: join(dir, 'containers.json'), lock: join(dir, '.lock') });

export const emptyIndex = () => ({
  version: 1,
  machine: { range: [...DEFAULT_MACHINE.range], blockSize: DEFAULT_MACHINE.blockSize },
  containers: [],
});

export function loadIndex(dir) {
  const { file } = indexFiles(dir);
  return parseWith(IndexSchema, readJson(file, { onMissing: emptyIndex }), file);
}

export async function claimContainer(dir, { path, id, baseId, blockSize, now }) {
  const { file, lock } = indexFiles(dir);
  return withLock(lock, async () => {
    const index = loadIndex(dir);
    if (index.containers.some((c) => c.path === path)) {
      throw new InvalidInputError(`${path} is already registered as a L.AI.nes container.`);
    }
    const taken = index.containers.map((c) => c.id);
    let chosen;
    if (id !== undefined) {
      validateId(id);
      if (taken.includes(id)) throw new InvalidInputError(`Container id "${id}" is already used on this machine. Pick another with --id.`);
      chosen = id;
    } else {
      chosen = uniqueId(baseId, taken);
    }
    const size = blockSize ?? index.machine.blockSize;
    const portRange = allocateBlock({ range: index.machine.range, blockSize: size }, index.containers.map((c) => c.portRange));
    const entry = { id: chosen, path, portRange, created: now };
    index.containers.push(entry);
    writeJson(file, index);
    return entry;
  });
}

export async function releaseContainer(dir, id) {
  const { file, lock } = indexFiles(dir);
  await withLock(lock, async () => {
    const index = loadIndex(dir);
    index.containers = index.containers.filter((c) => c.id !== id);
    writeJson(file, index);
  });
}

export async function pruneIndex(dir) {
  const { file, lock } = indexFiles(dir);
  return withLock(lock, async () => {
    const index = loadIndex(dir);
    const alive = (c) => existsSync(join(c.path, '.laines', 'container.json'));
    const removed = index.containers.filter((c) => !alive(c));
    if (removed.length) {
      index.containers = index.containers.filter(alive);
      writeJson(file, index);
    }
    return removed;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:run -- test/machine-index.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/machine-index.js test/machine-index.test.js
git commit -m "feat: machine index with locked id and port-block claims"
```

---

### Task 6: Container config

**Files:**
- Create: `src/config.js`
- Test: `test/config.test.js`

**Interfaces:**
- Consumes: `readJson` (Task 2), `parseWith` (Task 2), `NotAContainerError`.
- Produces:
  - `ConfigSchema` (zod) with the defaults below
  - `buildConfig({ repoName, remote, defaultBranch, agents }) → Config`
  - `loadConfig(file) → Config` (missing → `NotAContainerError(<container root>)`; invalid → `MalformedConfigError`)

- [ ] **Step 1: Write the failing test**

`test/config.test.js`:
```js
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildConfig, loadConfig } from '../src/config.js';
import { MalformedConfigError, NotAContainerError } from '../src/lib/errors.js';
import { tmp, cleanupTmp } from './helpers.js';

afterEach(cleanupTmp);

describe('config', () => {
  it('fills every default', () => {
    const c = buildConfig({ repoName: 'app', remote: 'git@example.com:o/app.git', defaultBranch: 'main', agents: ['claude'] });
    expect(c).toEqual({
      repos: { app: { remote: 'git@example.com:o/app.git', defaultBranch: 'main' } },
      lanePrefix: 'lane_',
      maxLanes: 20,
      ports: { stride: 10 },
      hooks: { policy: 'notify', timeoutSec: 300, stableAfter: 3 },
      teardown: { mcp: 'confirm' },
      capabilities: { create: true, report: true, keep: true, teardown: true },
      agents: ['claude'],
      agentCmd: 'claude',
      board: { logLimit: 200 },
      locked: false,
    });
  });

  it('loads a file, reporting a missing one as not-a-container and bad values as malformed', () => {
    const root = tmp();
    const file = join(root, '.laines', 'config.json');
    expect(() => loadConfig(file)).toThrow(NotAContainerError);
    mkdirSync(join(root, '.laines'));
    writeFileSync(file, JSON.stringify({ repos: { app: { remote: 'x' } }, hooks: { policy: 'yolo' } }));
    expect(() => loadConfig(file)).toThrow(/hooks\.policy/);
    writeFileSync(file, JSON.stringify({ repos: { app: { remote: 'x' } }, typo: 1 }));
    expect(() => loadConfig(file)).toThrow(MalformedConfigError);
    writeFileSync(file, JSON.stringify({ repos: { a: { remote: 'x' }, b: { remote: 'y' } } }));
    expect(() => loadConfig(file)).toThrow(/exactly one repo/);
    writeFileSync(file, JSON.stringify({ repos: { app: { remote: 'x' } } }));
    expect(loadConfig(file).hooks.policy).toBe('notify');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- test/config.test.js`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 3: Implement**

`src/config.js` (zod 4: nested objects use `.prefault({})` so their inner defaults are applied; `.default()` would short-circuit and skip them):
```js
import { dirname } from 'node:path';
import { z } from 'zod';
import { readJson } from './lib/jsonfile.js';
import { parseWith } from './lib/schema.js';
import { NotAContainerError } from './lib/errors.js';

const Repo = z.strictObject({
  remote: z.string().min(1),
  defaultBranch: z.string().min(1).default('main'),
});

export const ConfigSchema = z.strictObject({
  repos: z
    .record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'repo names use lowercase letters, digits and hyphens'), Repo)
    .refine((r) => Object.keys(r).length === 1, 'exactly one repo is supported in this version'),
  lanePrefix: z.string().regex(/^[a-z][a-z0-9_-]*$/).default('lane_'),
  maxLanes: z.number().int().min(1).max(200).default(20),
  ports: z.strictObject({ stride: z.number().int().min(1).max(100).default(10) }).prefault({}),
  hooks: z
    .strictObject({
      policy: z.enum(['approve', 'notify', 'open']).default('notify'),
      timeoutSec: z.number().int().min(1).max(3600).default(300),
      stableAfter: z.number().int().min(1).max(100).default(3),
    })
    .prefault({}),
  teardown: z.strictObject({ mcp: z.enum(['confirm', 'auto', 'off']).default('confirm') }).prefault({}),
  capabilities: z
    .strictObject({
      create: z.boolean().default(true),
      report: z.boolean().default(true),
      keep: z.boolean().default(true),
      teardown: z.boolean().default(true),
    })
    .prefault({}),
  agents: z
    .array(z.enum(['claude', 'codex', 'gemini']))
    .min(1)
    .refine((a) => new Set(a).size === a.length, 'agents must not repeat')
    .default(['claude']),
  agentCmd: z.string().min(1).default('claude'),
  board: z.strictObject({ logLimit: z.number().int().min(10).max(10000).default(200) }).prefault({}),
  locked: z.boolean().default(false),
});

export function buildConfig({ repoName, remote, defaultBranch, agents }) {
  return parseWith(ConfigSchema, { repos: { [repoName]: { remote, defaultBranch } }, agents }, '(new config)');
}

export function loadConfig(file) {
  const raw = readJson(file, {
    onMissing: () => {
      throw new NotAContainerError(dirname(dirname(file)));
    },
  });
  return parseWith(ConfigSchema, raw, file);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:run -- test/config.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat: container config schema with defaults"
```

---

### Task 7: Lanes state and board renderer

**Files:**
- Create: `src/lib/lanes-state.js`, `src/lib/board.js`
- Test: `test/board.test.js`

**Interfaces:**
- Consumes: `parseWith` (Task 2).
- Produces:
  - `LanesStateSchema`, `emptyLanesState() → { version: 1, lanes: {}, requests: [], hookHistory: [], activity: [] }`, `parseLanesState(data, file) → state`
  - `addActivity(state, { ts, lane, text }, logLimit) → { state, overflow }` (pure; newest first; `overflow` = entries beyond `logLimit`, oldest last)
  - `oneLine(value) → string` (collapses CR/LF runs to one space, trims)
  - `fmtTs(iso) → 'YYYY-MM-DD HH:MM UTC'`
  - `renderBoard({ container: { id, portRange, hooksPolicy, teardownMcp }, state }) → string`

Lane record shape (spec §6.2): `{ number, repos: [{ name, path, branch }], ports: [s, e], state: 'active'|'setup-failed'|'closed', status, task: string|null, blocked: string|null, kept: { reason, since }|null, created, updated, closed?: string|null }`. Request shape: `{ id, ts, lane: string|null, kind, text, command }`.

- [ ] **Step 1: Write the failing test**

`test/board.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { emptyLanesState, addActivity, parseLanesState } from '../src/lib/lanes-state.js';
import { renderBoard, oneLine, fmtTs } from '../src/lib/board.js';
import { MalformedConfigError } from '../src/lib/errors.js';

const container = { id: 'app', portRange: [20000, 20199], hooksPolicy: 'notify', teardownMcp: 'confirm' };
const lane = (over = {}) => ({
  number: 2,
  repos: [{ name: 'app', path: 'lane_2', branch: 'feat/x' }],
  ports: [20010, 20019],
  state: 'active',
  status: 'in-progress',
  task: 'Webhooks',
  blocked: null,
  kept: null,
  created: '2026-09-29T12:00:00.000Z',
  updated: '2026-09-29T14:02:00.000Z',
  ...over,
});

describe('lanes state', () => {
  it('starts empty and validates', () => {
    expect(emptyLanesState()).toEqual({ version: 1, lanes: {}, requests: [], hookHistory: [], activity: [] });
    expect(() => parseLanesState({ version: 1, lanes: 'x' }, 'lanes.json')).toThrow(MalformedConfigError);
    expect(parseLanesState({ ...emptyLanesState(), lanes: { lane_2: lane() } }, 'f').lanes.lane_2.number).toBe(2);
  });

  it('adds activity newest-first and returns the overflow', () => {
    let state = emptyLanesState();
    for (let i = 1; i <= 12; i++) {
      ({ state } = addActivity(state, { ts: `t${i}`, lane: null, text: `e${i}` }, 10));
    }
    const { state: next, overflow } = addActivity(state, { ts: 't13', lane: 'lane_1', text: 'e13' }, 10);
    expect(next.activity).toHaveLength(10);
    expect(next.activity[0].text).toBe('e13');
    expect(overflow.map((e) => e.text)).toEqual(['e3']);
    expect(state.activity[0].text).toBe('e12');
  });
});

describe('board', () => {
  it('formats helpers', () => {
    expect(fmtTs('2026-09-29T14:02:33.000Z')).toBe('2026-09-29 14:02 UTC');
    expect(oneLine(' a\r\n\n b ')).toBe('a b');
  });

  it('renders an empty board with every section', () => {
    const md = renderBoard({ container, state: emptyLanesState() });
    expect(md).toContain('# Lanes Board: app');
    expect(md).toContain('ports 20000–20199');
    for (const h of ['## Status', '## Requests', '## Closed', '## Activity Log']) expect(md).toContain(h);
    expect(md).toContain('No active lanes');
  });

  it('renders lane blocks, kept lanes, requests, closed lanes and activity', () => {
    const state = {
      ...emptyLanesState(),
      lanes: {
        lane_2: lane({ kept: { reason: 'base of PR #123', since: '2026-09-29T13:00:00.000Z' } }),
        lane_1: lane({ number: 1, state: 'closed', closed: '2026-09-28T10:00:00.000Z', repos: [{ name: 'app', path: 'lane_1', branch: 'main' }] }),
        lane_3: lane({ number: 3, state: 'setup-failed', repos: [{ name: 'app', path: 'lane_3', branch: 'main' }] }),
      },
      requests: [{ id: 'r1', ts: '2026-09-29T14:10:00.000Z', lane: 'lane_3', kind: 'setup-failed', text: 'post-create failed', command: 'laines refresh lane_3' }],
      activity: [{ ts: '2026-09-29T14:02:00.000Z', lane: 'lane_2', text: 'opened PR' }],
    };
    const md = renderBoard({ container, state });
    expect(md).toContain('<!-- lane:lane_2:start -->\n### lane_2 📌');
    expect(md).toContain('- **Kept:** base of PR #123');
    expect(md).toContain('- **Ports:** 20010–20019 · **Env:** lane_2/.laines.env');
    expect(md).toContain('### lane_3 ⚠️ setup-failed');
    expect(md).toContain('→ `laines refresh lane_3`');
    expect(md).toContain('1 closed lane');
    expect(md).toContain('`lane_1`');
    expect(md).toContain('- **2026-09-29 14:02 UTC** · `lane_2`: opened PR');
    expect(md.indexOf('lane_2 📌')).toBeGreaterThan(md.indexOf('## Status'));
    expect(md.indexOf('lane_2 📌')).toBeLessThan(md.indexOf('## Requests'));
    expect(md).not.toMatch(/<!-- lane:lane_1:start -->/);
  });

  it('keeps structure intact when user text contains newlines and markers', () => {
    const state = {
      ...emptyLanesState(),
      lanes: { lane_2: lane({ task: 'line1\n## Requests\n<!-- lane:lane_2:end -->', blocked: 'a\r\nb' }) },
    };
    const md = renderBoard({ container, state });
    expect(md.match(/^## Requests$/gm)).toHaveLength(1);
    expect(md.match(/<!-- lane:lane_2:end -->/g)).toHaveLength(1);
    expect(md).toContain('- **Blocked on:** a b');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- test/board.test.js`
Expected: FAIL — cannot resolve `../src/lib/lanes-state.js`.

- [ ] **Step 3: Implement**

`src/lib/lanes-state.js`:
```js
import { z } from 'zod';
import { parseWith } from './schema.js';

const Lane = z.strictObject({
  number: z.number().int().positive(),
  repos: z.array(z.strictObject({ name: z.string(), path: z.string(), branch: z.string() })).min(1),
  ports: z.tuple([z.number().int(), z.number().int()]),
  state: z.enum(['active', 'setup-failed', 'closed']),
  status: z.string(),
  task: z.string().nullable(),
  blocked: z.string().nullable(),
  kept: z.strictObject({ reason: z.string(), since: z.string() }).nullable(),
  created: z.string(),
  updated: z.string(),
  closed: z.string().nullable().optional(),
});

export const LanesStateSchema = z.strictObject({
  version: z.literal(1),
  lanes: z.record(z.string(), Lane),
  requests: z.array(
    z.strictObject({
      id: z.string(),
      ts: z.string(),
      lane: z.string().nullable(),
      kind: z.string(),
      text: z.string(),
      command: z.string(),
    }),
  ),
  hookHistory: z.array(z.strictObject({ ts: z.string(), checksums: z.record(z.string(), z.string()) })),
  activity: z.array(z.strictObject({ ts: z.string(), lane: z.string().nullable(), text: z.string() })),
});

export const emptyLanesState = () => ({ version: 1, lanes: {}, requests: [], hookHistory: [], activity: [] });

export const parseLanesState = (data, file) => parseWith(LanesStateSchema, data, file);

// Pure: returns a new state; entries beyond logLimit come back as overflow for the caller to archive.
export function addActivity(state, entry, logLimit) {
  const all = [entry, ...state.activity];
  return { state: { ...state, activity: all.slice(0, logLimit) }, overflow: all.slice(logLimit) };
}
```

`src/lib/board.js`:
```js
export const oneLine = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

// Markers and headings in user text must never be mistaken for board structure.
const safe = (value) => oneLine(value).replace(/<!--/g, '&lt;!--').replace(/^#+\s*/, '');

export const fmtTs = (iso) => `${String(iso).slice(0, 16).replace('T', ' ')} UTC`;

function laneBlock(name, lane) {
  const flags = `${lane.kept ? ' 📌' : ''}${lane.state === 'setup-failed' ? ' ⚠️ setup-failed' : ''}`;
  const lines = [
    `<!-- lane:${name}:start -->`,
    `### ${name}${flags}`,
    `- **Status:** ${safe(lane.status)}`,
    `- **Branch:** ${safe(lane.repos[0].branch)}`,
    `- **Task:** ${lane.task ? safe(lane.task) : '_unassigned_'}`,
    `- **Blocked on:** ${lane.blocked ? safe(lane.blocked) : '-'}`,
    `- **Ports:** ${lane.ports[0]}–${lane.ports[1]} · **Env:** ${lane.repos[0].path}/.laines.env`,
  ];
  if (lane.kept) lines.push(`- **Kept:** ${safe(lane.kept.reason)}`);
  lines.push(`- **Last update:** ${fmtTs(lane.updated)}`, `<!-- lane:${name}:end -->`);
  return lines.join('\n');
}

export function renderBoard({ container, state }) {
  const entries = Object.entries(state.lanes).sort(([, a], [, b]) => a.number - b.number);
  const open = entries.filter(([, l]) => l.state !== 'closed');
  const closed = entries.filter(([, l]) => l.state === 'closed');
  const out = [
    `# Lanes Board: ${container.id}`,
    '',
    `_Container \`${container.id}\` · ports ${container.portRange[0]}–${container.portRange[1]} · hook policy: ${container.hooksPolicy} · teardown over MCP: ${container.teardownMcp}_`,
    '_Generated by laines from `.laines/lanes.json`. Do not edit by hand; use `laines report`._',
    '',
    '## Status',
    '',
    open.length ? open.map(([n, l]) => laneBlock(n, l)).join('\n\n') : '_No active lanes. Create one with `laines create`._',
    '',
    '## Requests',
    '',
    '_Waiting on a human. Each line shows the command that resolves it._',
    '',
    state.requests.length
      ? state.requests.map((r) => `- **${fmtTs(r.ts)}** · ${r.lane ? `\`${r.lane}\` ` : ''}${safe(r.text)} → \`${oneLine(r.command)}\``).join('\n')
      : '_Nothing waiting._',
    '',
    '## Closed',
    '',
    closed.length
      ? [
          `<details><summary>${closed.length} closed lane${closed.length === 1 ? '' : 's'}</summary>`,
          '',
          ...closed.map(([n, l]) => `- \`${n}\` · closed ${fmtTs(l.closed ?? l.updated)} · last branch \`${oneLine(l.repos[0].branch)}\``),
          '',
          '</details>',
        ].join('\n')
      : '_None._',
    '',
    '## Activity Log',
    '',
    '_Newest first. Written by laines._',
    '',
    state.activity.length
      ? state.activity.map((a) => `- **${fmtTs(a.ts)}** · ${a.lane ? `\`${a.lane}\`: ` : ''}${safe(a.text)}`).join('\n')
      : '_No activity yet._',
    '',
  ];
  return out.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:run -- test/board.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/lanes-state.js src/lib/board.js test/board.test.js
git commit -m "feat: lanes state schema and board renderer"
```

---

### Task 8: Templates and agent-file wiring

**Files:**
- Create: `templates/lanes-block.md`, `templates/lane-management.md`, `templates/lane-ai-readme.md`, `templates/lane-context-readme.md`, `templates/lane-plans-readme.md`, `templates/hooks-readme.md`, `templates/context-board-note.md`, `src/lib/templates.js`, `src/lib/agent-files.js`
- Test: `test/agent-files.test.js`

**Interfaces:**
- Consumes: `readJson`, `writeJson` (Task 2), `InvalidInputError`, `MalformedConfigError`.
- Produces:
  - `TEMPLATES_DIR`, `readTemplate(name) → string`, `renderTemplate(text, vars) → string` (unknown `{{var}}` → `Error`)
  - `AGENT_FLAGS = { claude: '--claude', codex: '--codex', gemini: '--gemini' }`, `AGENT_FILES = { claude: 'CLAUDE.md', codex: 'AGENTS.md', gemini: 'GEMINI.md' }`
  - `LANES_BEGIN`, `LANES_END`, `upsertBlock(file, body) → 'written'|'unchanged'`
  - `HUMAN_ONLY_COMMANDS`, `denyRules() → string[]`, `mergeDenyRules(file, rules) → { added: string[] }`
  - `addIndexRow(readme, file, answers) → 'written'|'unchanged'|'missing'`
  - `appendOnce(file, key, text) → 'written'|'unchanged'`

- [ ] **Step 1: Write the template files**

`templates/lanes-block.md` (the body; `upsertBlock` adds the markers):
```markdown
## L.AI.nes lanes (container `{{containerId}}`)

This directory is a L.AI.nes container. Each `lane_*/` directory is an independent clone of the
project with its own local environment. This container's `.ai/` is the shared knowledge layer for
every lane.

**Which mode am I in?** Look for `.ai/.lane.json` at the root of the git repository you are
working in.
- **Present, and the `container` path it names has `.laines/container.json`:** you are in a lane.
  Follow the lane rules below.
- **Absent:** you are not in a lane. Ignore this section and use normal `.ai/` resolution. Do not
  look for a container or report to a board.
- **In the container directory itself (not inside a git repository):** you are the container
  session. Create, monitor and tear down lanes with `laines`; see
  `.ai/runbooks/lane-management.md`.

**Lane rules**
1. A lane owns only its `.ai/context/` and `.ai/plans/`. Write new knowledge, guidelines, lessons,
   data and audits to this container's `.ai/`, never into the lane.
2. If the repository commits its own `.ai/`, read it as project truth (it wins on conflict). Change
   it only when the task is itself a change to the project's docs.
3. Never run `dot-ai init` or `dot-ai sync` inside a lane.
4. Report meaningful status changes with `laines report <lane> --status "..." --task "..."` or the
   `laines_report` MCP tool.
5. Do not edit `.laines/` (except hook scripts in `.laines/hooks/`, which run only as the hook
   policy allows) or another lane's files. Teardown, release, hook approval, hook policy and config
   changes are for a human.
6. Source the lane's `.laines.env` before starting services, and use only the lane's ports.
```

`templates/lane-management.md`:
```markdown
# Lane management

How lanes are created, used, monitored and closed in container `{{containerId}}`.

## The shape of this setup

- **The container** (this directory) holds the shared `.ai/` layer, `.laines/` (settings, lane
  index, hooks, audit log), and the lanes. It is not a git repository.
- **Lanes** (`lane_1/`, `lane_2/`, …) are standard `git clone`s of the project. Each lane has its
  own port block, its own `.laines.env`, and lane-local `.ai/context/` and `.ai/plans/`. Everything
  else (knowledge, guidelines, lessons, data, audits) lives in the container's `.ai/` so it
  outlives any lane.
- **The board** (`.ai/context/LANES_BOARD.md`) shows every lane's status, the requests waiting on a
  human, and recent activity. `laines` generates it; nobody edits it by hand.

A session in the container creates, monitors and closes lanes. Lane work happens either in a new
agent session started inside the lane, or in a subagent the container session dispatches with the
handoff from `laines brief <lane>`.

## Creating a lane

    laines create [name] [--branch <branch>]

Clones the project, writes the lane-local files (hidden from git through `.git/info/exclude`),
allocates the lane's ports and names, writes `.laines.env`, runs the `post-create` hook, and prints
the lane's brief.

## Working in a lane

1. Read the shared layer (`knowledge/`, `guidelines/`, `lessons/` in this container's `.ai/`) and
   the repository's own instructions.
2. Check the lane's board entry, then its `context/` and `plans/`.
3. Source `.laines.env` before starting services; use only the lane's ports.
4. Report when status meaningfully changes (starting a task, blocked, in review, done):

       laines report <lane> --status in-progress --task "short description"
       laines report <lane> --blocked "waiting on staging credentials"
       laines report <lane> --note "opened PR #123"

5. Promote anything durable into the container's `.ai/` before the lane closes.

## Keeping a lane

A lane that other work depends on (for example the base of stacked PRs) should be kept:

    laines keep <lane> --reason "base of stacked PR #123"

A kept lane cannot be torn down by any path until a human runs `laines release <lane>`.

## Closing a lane

    laines teardown <lane>               # archive plans, delete context, mark closed; clone stays
    laines teardown <lane> --remove-dir  # also delete the clone

`--remove-dir` refuses if the lane has uncommitted changes, stash entries, or commits that exist on
no remote, and reports which refs hold them. Save unpushed work instead of forcing:

    git -C <lane> bundle create ~/lane-backup.bundle --all --not --remotes

Over MCP, teardown asks the human to confirm by default. Teardown, release, hook approval, hook
policy and config changes are human actions.

## Hooks

Stack-specific setup lives in `.laines/hooks/` (`post-create`, `pre-teardown`, `post-teardown`).
See `.laines/hooks/README.md`. New containers run changed hooks and flag them on the board
(policy `notify`); once the hooks are stable, lock them with `laines hooks approve --lock`.

## Monitoring

    laines watch                 # follow the board
    laines status [lane]         # current state as JSON (or --format table)
    laines doctor                # check the container, lanes and agent setup

## Common pitfalls

- **Local services are shared unless namespaced.** Separate clones do not mean separate databases,
  caches or queues. Use `LANE_SUFFIX` and the lane's ports (from `.laines.env`) in your hooks and
  config.
- **Keep lane-local config patches out of commits.** If isolation needs an edit to a tracked file,
  `git update-index --skip-worktree <file>` hides it; unset it before pulling changes to that file.
- **Stop what you start.** Stop a lane's servers before tearing it down and check its ports are
  free again.
```

`templates/lane-ai-readme.md`:
```markdown
# .ai/ — lane `{{lane}}` (partial by design)

This lane of container `{{containerId}}` keeps only `context/` and `plans/` here. Knowledge,
guidelines, lessons, data and audits live in the container's shared layer:
`{{containerDir}}/.ai/`. Do not create those folders in this lane.

## Rules for this lane

1. **Read the shared layer first:** `{{containerDir}}/.ai/knowledge/`, `guidelines/` and
   `lessons/`, plus this repository's own committed instructions.
2. **Pick up where the last session stopped:** this lane's entry on the board
   (`{{containerDir}}/.ai/context/LANES_BOARD.md`), then `context/` and `plans/` here.
3. **Report as you work:** `laines report {{lane}} --status "..." --task "..."`.
4. **Promote before you finish:** durable findings go to the container's `knowledge/`,
   `guidelines/` or `lessons/`, not left here to be archived.
5. **Stay inside this lane:** source `.laines.env`, use only this lane's ports, and never run
   `dot-ai init` or `dot-ai sync` here.

Full protocol: `{{containerDir}}/.ai/runbooks/lane-management.md`
```

`templates/lane-context-readme.md`:
```markdown
# context/ — lane `{{lane}}`

This lane's live working state: current task, open questions, handoff notes for whoever picks the
lane up next. Deleted when the lane is torn down, so promote anything durable to
`{{containerDir}}/.ai/knowledge/`, `guidelines/` or `lessons/` first.
```

`templates/lane-plans-readme.md`:
```markdown
# plans/ — lane `{{lane}}`

Plans for this lane's current task. Archived to the container's `.ai/archive/` when the lane is
torn down. Plans that span several lanes belong in `{{containerDir}}/.ai/plans/`.
```

`templates/hooks-readme.md`:
```markdown
# Hooks

Project-specific lane setup and cleanup. Each hook is an executable file named after its event,
optionally followed by executables in `<event>.d/`, run in name order.

| Hook | Runs | Working directory | On failure |
|---|---|---|---|
| `post-create` | after a lane is cloned and its files and `.laines.env` are written; again on `laines refresh` | lane | lane kept and marked `setup-failed` |
| `pre-teardown` | before anything is archived or deleted | lane | teardown aborted, nothing touched |
| `post-teardown` | after the lane is closed | container | warning and a board note |

Environment: `LANE_NAME`, `LANE_NUMBER`, `LANE_ID`, `LANE_DIR`, `CONTAINER_DIR`, `CONTAINER_ID`,
`LANE_PORT_BASE`, `LANE_PORT_COUNT`, `LANE_SUFFIX`, `LANE_BRANCH`, `LANE_ENV_FILE`, `LAINES_HOOK`,
`LAINES_DRY_RUN`.

Exit `0` for success, `3` when a human must act first (for example "start Postgres, then run
`laines refresh`"), anything else for failure. Hooks time out after 300 seconds by default.

Hook policy (`laines config get hooks.policy`): `notify` runs changed hooks and flags them on the
board; `approve` refuses changed hooks until a human runs `laines hooks approve`; `open` runs
hooks without checks. Lock a stable set with `laines hooks approve --lock`.
```

`templates/context-board-note.md`:
```markdown
## Lanes board

`LANES_BOARD.md` is long-lived, unlike the rest of this folder. It is the live status board that
lanes report to and the container session watches. `laines` regenerates it from
`.laines/lanes.json`; do not edit or delete it by hand.
```

- [ ] **Step 2: Write the failing test**

`test/agent-files.test.js`:
```js
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readTemplate, renderTemplate } from '../src/lib/templates.js';
import {
  LANES_BEGIN, LANES_END, upsertBlock, denyRules, mergeDenyRules, addIndexRow, appendOnce, HUMAN_ONLY_COMMANDS,
} from '../src/lib/agent-files.js';
import { InvalidInputError, MalformedConfigError } from '../src/lib/errors.js';
import { tmp, cleanupTmp } from './helpers.js';

afterEach(cleanupTmp);

describe('templates', () => {
  it('renders variables and rejects unknown ones', () => {
    expect(renderTemplate('a {{x}} b', { x: 1 })).toBe('a 1 b');
    expect(() => renderTemplate('{{nope}}', {})).toThrow('nope');
  });

  it('ships every template, each rendering with its documented variables', () => {
    const vars = { containerId: 'app', lane: 'lane_1', containerDir: '/c' };
    for (const name of ['lanes-block.md', 'lane-management.md', 'lane-ai-readme.md', 'lane-context-readme.md', 'lane-plans-readme.md', 'hooks-readme.md', 'context-board-note.md']) {
      expect(renderTemplate(readTemplate(name), vars).length).toBeGreaterThan(50);
    }
  });
});

describe('upsertBlock', () => {
  it('appends after existing content, then replaces in place idempotently', () => {
    const f = join(tmp(), 'CLAUDE.md');
    writeFileSync(f, '<!-- BEGIN .ai-convention -->\nx\n<!-- END .ai-convention -->\n');
    expect(upsertBlock(f, 'v1')).toBe('written');
    let txt = readFileSync(f, 'utf8');
    expect(txt.indexOf(LANES_BEGIN)).toBeGreaterThan(txt.indexOf('<!-- END .ai-convention -->'));
    expect(upsertBlock(f, 'v1')).toBe('unchanged');
    upsertBlock(f, 'v2');
    txt = readFileSync(f, 'utf8');
    expect(txt).toContain(`${LANES_BEGIN}\nv2\n${LANES_END}`);
    expect(txt).not.toContain('v1');
    expect(txt.match(new RegExp(LANES_BEGIN, 'g'))).toHaveLength(1);
  });

  it('creates a missing file and refuses a half-open block', () => {
    const d = tmp();
    expect(upsertBlock(join(d, 'AGENTS.md'), 'b')).toBe('written');
    writeFileSync(join(d, 'GEMINI.md'), `${LANES_BEGIN}\nno end\n`);
    expect(() => upsertBlock(join(d, 'GEMINI.md'), 'b')).toThrow(InvalidInputError);
  });
});

describe('deny rules', () => {
  it('covers every human-only command for each invocation form', () => {
    const rules = denyRules();
    for (const c of HUMAN_ONLY_COMMANDS) {
      expect(rules).toContain(`Bash(laines ${c}:*)`);
      expect(rules).toContain(`Bash(npx @ajmarquez99/laines ${c}:*)`);
    }
  });

  it('merges into existing settings without dropping user rules, and is idempotent', () => {
    const d = tmp();
    const f = join(d, '.claude', 'settings.json');
    mkdirSync(join(d, '.claude'));
    writeFileSync(f, JSON.stringify({ model: 'x', permissions: { deny: ['Bash(rm:*)'], allow: ['Read'] } }));
    expect(mergeDenyRules(f, ['Bash(laines release:*)']).added).toEqual(['Bash(laines release:*)']);
    const s = JSON.parse(readFileSync(f, 'utf8'));
    expect(s.model).toBe('x');
    expect(s.permissions.allow).toEqual(['Read']);
    expect(s.permissions.deny).toEqual(['Bash(rm:*)', 'Bash(laines release:*)']);
    expect(mergeDenyRules(f, ['Bash(laines release:*)']).added).toEqual([]);
  });

  it('refuses to overwrite an invalid settings file', () => {
    const d = tmp();
    const f = join(d, 'settings.json');
    writeFileSync(f, '{ broken');
    expect(() => mergeDenyRules(f, ['x'])).toThrow(MalformedConfigError);
    expect(readFileSync(f, 'utf8')).toBe('{ broken');
  });
});

describe('index rows and one-time sections', () => {
  it('adds an index row once', () => {
    const f = join(tmp(), 'README.md');
    writeFileSync(f, '## Index\n\n| File | Answers |\n|---|---|\n');
    expect(addIndexRow(f, 'a.md', 'What A answers')).toBe('written');
    expect(addIndexRow(f, 'a.md', 'What A answers')).toBe('unchanged');
    expect(readFileSync(f, 'utf8')).toBe('## Index\n\n| File | Answers |\n|---|---|\n| [a.md](a.md) | What A answers |\n');
    expect(addIndexRow(join(tmp(), 'nope.md'), 'a.md', 'x')).toBe('missing');
  });

  it('appends a keyed section once', () => {
    const f = join(tmp(), 'README.md');
    writeFileSync(f, 'head\n');
    appendOnce(f, 'board-note', 'note');
    appendOnce(f, 'board-note', 'note');
    expect(readFileSync(f, 'utf8')).toBe('head\n\n<!-- laines:board-note -->\nnote\n');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test:run -- test/agent-files.test.js`
Expected: FAIL — cannot resolve `../src/lib/templates.js`.

- [ ] **Step 4: Implement**

`src/lib/templates.js`:
```js
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEMPLATES_DIR = fileURLToPath(new URL('../../templates/', import.meta.url));

export const readTemplate = (name) => readFileSync(join(TEMPLATES_DIR, name), 'utf8');

// Unknown variables are a programming error: fail loudly instead of shipping "{{x}}".
export function renderTemplate(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (_m, key) => {
    if (!(key in vars)) throw new Error(`Template variable "${key}" has no value`);
    return String(vars[key]);
  });
}
```

`src/lib/agent-files.js`:
```js
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readJson, writeJson } from './jsonfile.js';
import { InvalidInputError, MalformedConfigError } from './errors.js';

export const AGENT_FLAGS = { claude: '--claude', codex: '--codex', gemini: '--gemini' };
export const AGENT_FILES = { claude: 'CLAUDE.md', codex: 'AGENTS.md', gemini: 'GEMINI.md' };

export const LANES_BEGIN = '<!-- BEGIN laines-lanes -->';
export const LANES_END = '<!-- END laines-lanes -->';

// Appended at the end of the file, so it always follows dot-ai's convention block, which
// `dot-ai sync` rewrites in place without touching anything after its END marker.
export function upsertBlock(file, body) {
  const block = `${LANES_BEGIN}\n${body.replace(/\n+$/, '')}\n${LANES_END}`;
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const b = cur.indexOf(LANES_BEGIN);
  const e = cur.indexOf(LANES_END);
  let next;
  if (b !== -1 && e > b) {
    next = cur.slice(0, b) + block + cur.slice(e + LANES_END.length);
  } else if (b !== -1 || e !== -1) {
    throw new InvalidInputError(`${file} has an incomplete laines-lanes block (one marker without the other). Fix or remove the markers and retry.`);
  } else {
    next = (cur ? cur.replace(/\n*$/, '\n\n') : '') + block + '\n';
  }
  if (next === cur) return 'unchanged';
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
  return 'written';
}

export const HUMAN_ONLY_COMMANDS = ['teardown', 'release', 'hooks approve', 'hooks policy', 'config set'];
const INVOCATIONS = ['laines', 'npx laines', 'npx @ajmarquez99/laines'];

export const denyRules = () => HUMAN_ONLY_COMMANDS.flatMap((c) => INVOCATIONS.map((i) => `Bash(${i} ${c}:*)`));

export function mergeDenyRules(file, rules) {
  const data = readJson(file, { onMissing: () => ({}) });
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new MalformedConfigError(file, 'expected a JSON object');
  }
  const permissions = data.permissions && typeof data.permissions === 'object' ? data.permissions : {};
  const deny = Array.isArray(permissions.deny) ? permissions.deny : [];
  const added = rules.filter((r) => !deny.includes(r));
  if (added.length) writeJson(file, { ...data, permissions: { ...permissions, deny: [...deny, ...added] } });
  return { added };
}

// dot-ai folder READMEs end with the `## Index` table, so a row can be appended at the end.
export function addIndexRow(readme, file, answers) {
  if (!existsSync(readme)) return 'missing';
  const cur = readFileSync(readme, 'utf8');
  if (cur.includes(`](${file})`)) return 'unchanged';
  writeFileSync(readme, `${cur.replace(/\n*$/, '\n')}| [${file}](${file}) | ${answers} |\n`);
  return 'written';
}

export function appendOnce(file, key, text) {
  const marker = `<!-- laines:${key} -->`;
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (cur.includes(marker)) return 'unchanged';
  writeFileSync(file, `${cur.replace(/\n*$/, '\n')}\n${marker}\n${text.replace(/\n+$/, '')}\n`);
  return 'written';
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:run -- test/agent-files.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add templates/ src/lib/templates.js src/lib/agent-files.js test/agent-files.test.js
git commit -m "feat: shipped templates and agent-file wiring"
```

---

### Task 9: Bundled dot-ai runner

**Files:**
- Create: `src/lib/dotai.js`
- Test: `test/dotai.test.js`

**Interfaces:**
- Consumes: `upsertBlock`, `LANES_BEGIN` (Task 8).
- Produces: `dotAiBin() → string` (absolute path to the bundled dot-ai CLI), `runDotAi(args, { cwd }) → { status: number|null, stdout: string, stderr: string, error?: Error }`.

- [ ] **Step 1: Write the failing test**

`test/dotai.test.js`:
```js
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dotAiBin, runDotAi } from '../src/lib/dotai.js';
import { upsertBlock, LANES_BEGIN } from '../src/lib/agent-files.js';
import { tmp, cleanupTmp } from './helpers.js';

afterEach(cleanupTmp);

describe('bundled dot-ai', () => {
  it('resolves the bundled CLI', () => {
    expect(existsSync(dotAiBin())).toBe(true);
  });

  it('initialises a layer non-interactively in the given cwd', () => {
    const d = tmp();
    const r = runDotAi(['init', '--claude'], { cwd: d });
    expect(r.status).toBe(0);
    expect(existsSync(join(d, '.ai', 'README.md'))).toBe(true);
    expect(readFileSync(join(d, 'CLAUDE.md'), 'utf8')).toContain('<!-- BEGIN .ai-convention -->');
  });

  it('keeps the laines-lanes block through dot-ai sync', () => {
    const d = tmp();
    expect(runDotAi(['init', '--claude'], { cwd: d }).status).toBe(0);
    upsertBlock(join(d, 'CLAUDE.md'), 'lane rules here');
    expect(runDotAi(['sync'], { cwd: d }).status).toBe(0);
    const txt = readFileSync(join(d, 'CLAUDE.md'), 'utf8');
    expect(txt).toContain(LANES_BEGIN);
    expect(txt).toContain('lane rules here');
  });

  it('reports a non-zero status instead of throwing', () => {
    const r = runDotAi(['--definitely-not-a-flag'], { cwd: tmp() });
    expect(r.status).not.toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- test/dotai.test.js`
Expected: FAIL — cannot resolve `../src/lib/dotai.js`.

- [ ] **Step 3: Implement**

`src/lib/dotai.js`:
```js
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

// dot-ai has no programmatic API; run its CLI from our own dependency tree so the version is pinned
// by package.json, never whatever `dot-ai` happens to be on PATH.
export function dotAiBin() {
  const pkgPath = require.resolve('@ajmarquez99/dot-ai/package.json');
  const pkg = require(pkgPath);
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['dot-ai'];
  return join(dirname(pkgPath), bin);
}

// dot-ai works on process.cwd() only, logs to stderr, and signals success through its exit code.
export function runDotAi(args, { cwd }) {
  const r = spawnSync(process.execPath, [dotAiBin(), ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:run -- test/dotai.test.js`
Expected: PASS (4 tests). If the sync test fails because dot-ai rewrote or dropped content after its END marker, stop and report: the spec's placement rule depends on it.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dotai.js test/dotai.test.js
git commit -m "feat: run the bundled dot-ai CLI"
```

---

### Task 10: `init` command

**Files:**
- Create: `src/deps.js`, `src/lib/audit.js`, `src/commands/init.js`
- Test: `test/init.test.js`

**Interfaces:**
- Consumes: everything from Tasks 2–9; `VERSION` (Task 1).
- Produces:
  - `defaultDeps = { env, homedir(), cwd(), now(), runDotAi(args, { cwd }), warn(msg) }`
  - `appendAudit(file, entry, { warn }) → boolean` (never throws)
  - `parseAgents(value) → Agent[]`
  - `runInit({ dir, remote, id?, agents?, branch?, dryRun? }, deps) → Promise<InitResult>` where `InitResult = { dryRun, id, path, portRange, repo: { name, remote, defaultBranch }, agents, files: string[], next: string[] }`
  - `CONTAINER_FILES(agents) → string[]` (relative paths `init` writes, used by the result and by doctor in M2)

- [ ] **Step 1: Write the failing test**

`test/init.test.js`:
```js
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit, parseAgents } from '../src/commands/init.js';
import { runDotAi } from '../src/lib/dotai.js';
import { loadIndex } from '../src/lib/machine-index.js';
import { loadConfig } from '../src/config.js';
import { denyRules, LANES_BEGIN } from '../src/lib/agent-files.js';
import { InvalidInputError, LainesError } from '../src/lib/errors.js';
import { tmp, cleanupTmp, testDeps } from './helpers.js';

afterEach(cleanupTmp);
const REMOTE = 'git@example.com:org/my-app.git';

function setup(overrides) {
  const root = tmp();
  mkdirSync(join(root, 'home'));
  return { root, deps: testDeps(root, { runDotAi, ...overrides }) };
}

describe('parseAgents', () => {
  it('parses, dedupes and validates', () => {
    expect(parseAgents(undefined)).toEqual(['claude']);
    expect(parseAgents('Claude, codex,claude')).toEqual(['claude', 'codex']);
    expect(() => parseAgents('claude,cursor')).toThrow(InvalidInputError);
  });
});

describe('runInit', () => {
  it('creates a complete container', async () => {
    const { root, deps } = setup();
    const r = await runInit({ dir: 'lanes', remote: REMOTE }, deps);
    const c = join(root, 'lanes');
    expect(r).toMatchObject({ dryRun: false, id: 'my-app', path: c, portRange: [20000, 20199], agents: ['claude'] });
    expect(r.repo).toEqual({ name: 'my-app', remote: REMOTE, defaultBranch: 'main' });
    for (const f of r.files) expect(existsSync(join(c, f)), f).toBe(true);
    expect(JSON.parse(readFileSync(join(c, '.laines', 'container.json'), 'utf8')).id).toBe('my-app');
    expect(loadConfig(join(c, '.laines', 'config.json')).hooks.policy).toBe('notify');
    expect(readFileSync(join(c, 'CLAUDE.md'), 'utf8')).toContain(LANES_BEGIN);
    expect(readFileSync(join(c, 'CLAUDE.md'), 'utf8')).toContain('container `my-app`');
    const settings = JSON.parse(readFileSync(join(c, '.claude', 'settings.json'), 'utf8'));
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(denyRules()));
    expect(readFileSync(join(c, '.ai', 'context', 'LANES_BOARD.md'), 'utf8')).toContain('# Lanes Board: my-app');
    expect(readFileSync(join(c, '.ai', 'runbooks', 'README.md'), 'utf8')).toContain('[lane-management.md](lane-management.md)');
    expect(readFileSync(join(c, '.ai', 'templates', 'README.md'), 'utf8')).toContain('[lane-ai-readme.md](lane-ai-readme.md)');
    expect(readFileSync(join(c, '.ai', 'context', 'README.md'), 'utf8')).toContain('<!-- laines:board-note -->');
    expect(readFileSync(join(c, '.laines', 'audit.jsonl'), 'utf8')).toContain('"action":"init"');
    expect(loadIndex(deps.env.LAINES_CONFIG_DIR).containers).toEqual([
      { id: 'my-app', path: c, portRange: [20000, 20199], created: '2026-09-29T12:00:00.000Z' },
    ]);
    expect(runDotAi(['doctor'], { cwd: c }).status).toBe(0);
  });

  it('wires every requested agent and gives a second container of the same repo its own id and block', async () => {
    const { root, deps } = setup();
    await runInit({ dir: 'a', remote: REMOTE }, deps);
    const r = await runInit({ dir: 'b', remote: REMOTE, agents: 'claude,codex,gemini' }, deps);
    expect(r.id).toBe('my-app-2');
    expect(r.portRange).toEqual([20200, 20399]);
    for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
      expect(readFileSync(join(root, 'b', f), 'utf8')).toContain(LANES_BEGIN);
    }
  });

  it('dry run writes nothing and claims nothing', async () => {
    const { root, deps } = setup();
    const r = await runInit({ dir: 'lanes', remote: REMOTE, dryRun: true }, deps);
    expect(r).toMatchObject({ dryRun: true, id: 'my-app', portRange: [20000, 20199] });
    expect(existsSync(join(root, 'lanes'))).toBe(false);
    expect(loadIndex(deps.env.LAINES_CONFIG_DIR).containers).toEqual([]);
  });

  it('refuses unsafe or occupied targets without touching the index', async () => {
    const { root, deps } = setup();
    mkdirSync(join(root, 'has-ai', '.ai'), { recursive: true });
    mkdirSync(join(root, 'has-laines', '.laines'), { recursive: true });
    writeFileSync(join(root, 'file'), 'x');
    await runInit({ dir: 'parent', remote: REMOTE }, deps);
    const cases = [
      { dir: 'has-ai' },
      { dir: 'has-laines' },
      { dir: 'file' },
      { dir: 'parent/inner' },
      { dir: '/' },
      { dir: join(root, 'home') },
      { dir: 'x', remote: '' },
      { dir: 'x', id: 'Bad Id' },
      { dir: 'x', agents: 'cursor' },
    ];
    for (const c of cases) {
      await expect(runInit({ remote: REMOTE, ...c }, deps), JSON.stringify(c)).rejects.toBeInstanceOf(InvalidInputError);
    }
    expect(loadIndex(deps.env.LAINES_CONFIG_DIR).containers.map((e) => e.id)).toEqual(['my-app']);
    expect(existsSync(join(root, 'x'))).toBe(false);
  });

  it('releases the index claim and names the partial directory when dot-ai fails', async () => {
    const failing = () => ({ status: 1, stdout: '', stderr: 'disk full' });
    const { root, deps } = setup({ runDotAi: failing });
    const err = await runInit({ dir: 'lanes', remote: REMOTE }, deps).catch((e) => e);
    expect(err).toBeInstanceOf(LainesError);
    expect(err.message).toContain('disk full');
    expect(err.message).toContain(join(root, 'lanes'));
    expect(loadIndex(deps.env.LAINES_CONFIG_DIR).containers).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- test/init.test.js`
Expected: FAIL — cannot resolve `../src/commands/init.js`.

- [ ] **Step 3: Implement**

`src/lib/audit.js`:
```js
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Metadata only. A failed audit write warns and never fails the action it records.
export function appendAudit(file, entry, { warn = () => {} } = {}) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(entry) + '\n');
    return true;
  } catch (err) {
    warn(`audit log write failed (${file}): ${err.message}`);
    return false;
  }
}
```

`src/deps.js`:
```js
import { homedir } from 'node:os';
import { runDotAi } from './lib/dotai.js';

// The only place real process state and external programs are wired in. Tests pass their own.
export const defaultDeps = {
  env: process.env,
  homedir: () => homedir(),
  cwd: () => process.cwd(),
  now: () => new Date().toISOString(),
  runDotAi: (args, opts) => runDotAi(args, opts),
  warn: (msg) => process.stderr.write(`warn: ${msg}\n`),
};
```

`src/commands/init.js`:
```js
import { existsSync, mkdirSync, realpathSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { VERSION } from '../version.js';
import { buildConfig } from '../config.js';
import { InvalidInputError, LainesError } from '../lib/errors.js';
import { writeJson } from '../lib/jsonfile.js';
import { configDir, containerPaths } from '../lib/paths.js';
import { repoSlugFromRemote, uniqueId, validateId } from '../lib/ids.js';
import { allocateBlock } from '../lib/ports.js';
import { claimContainer, loadIndex, releaseContainer } from '../lib/machine-index.js';
import { emptyLanesState } from '../lib/lanes-state.js';
import { renderBoard } from '../lib/board.js';
import { readTemplate, renderTemplate } from '../lib/templates.js';
import {
  AGENT_FILES, AGENT_FLAGS, addIndexRow, appendOnce, denyRules, mergeDenyRules, upsertBlock,
} from '../lib/agent-files.js';
import { appendAudit } from '../lib/audit.js';

const LANE_TEMPLATES = [
  ['lane-ai-readme.md', 'Lane-local `.ai/README.md`: lane rules and where the shared knowledge lives'],
  ['lane-context-readme.md', 'Lane-local `.ai/context/README.md`'],
  ['lane-plans-readme.md', 'Lane-local `.ai/plans/README.md`'],
];

export const CONTAINER_FILES = (agents) => [
  '.laines/container.json',
  '.laines/config.json',
  '.laines/lanes.json',
  '.laines/hooks.lock.json',
  '.laines/hooks/README.md',
  '.ai/context/LANES_BOARD.md',
  '.ai/runbooks/lane-management.md',
  ...LANE_TEMPLATES.map(([name]) => `.ai/templates/${name}`),
  '.claude/settings.json',
  ...agents.map((a) => AGENT_FILES[a]),
];

export function parseAgents(value) {
  const list = (Array.isArray(value) ? value : String(value ?? 'claude').split(','))
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const unknown = list.filter((a) => !(a in AGENT_FLAGS));
  if (unknown.length) throw new InvalidInputError(`Unknown agent(s): ${unknown.join(', ')}. Use any of: claude, codex, gemini.`);
  if (!list.length) throw new InvalidInputError('--agents needs at least one of: claude, codex, gemini.');
  return [...new Set(list)];
}

function assertSafeTarget(target, home) {
  if (target === parse(target).root) throw new InvalidInputError('Refusing to create a container at the filesystem root.');
  if (target === resolve(home)) throw new InvalidInputError('Refusing to create a container in your home directory itself; pick a subdirectory.');
  if (existsSync(target) && !statSync(target).isDirectory()) throw new InvalidInputError(`${target} exists and is not a directory.`);
  for (const name of ['.laines', '.ai']) {
    if (existsSync(join(target, name))) {
      throw new InvalidInputError(`${target} already has ${name}/. L.AI.nes creates fresh containers only; pick a new or empty directory.`);
    }
  }
  for (let dir = dirname(target); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.laines', 'container.json'))) {
      throw new InvalidInputError(`${target} is inside the container ${dir}. Create containers outside other containers.`);
    }
    if (dirname(dir) === dir) break;
  }
}

function writeContainer({ path, entry, config, agents, deps }) {
  const dot = deps.runDotAi(['init', ...agents.map((a) => AGENT_FLAGS[a])], { cwd: path });
  if (dot.error || dot.status !== 0) {
    const why = (dot.stderr || (dot.error && dot.error.message) || '').trim();
    throw new LainesError(`dot-ai init failed (exit ${dot.status ?? 'none'}):\n${why}`);
  }
  const p = containerPaths(path);
  const state = emptyLanesState();
  writeJson(p.marker, { id: entry.id, lainesVersion: VERSION, created: deps.now() });
  writeJson(p.config, config);
  writeJson(p.lanes, state);
  writeJson(p.hooksLock, { version: 1, hooks: {} });
  mkdirSync(p.hooks, { recursive: true });
  writeFileSync(join(p.hooks, 'README.md'), readTemplate('hooks-readme.md'));

  mkdirSync(dirname(p.runbook), { recursive: true });
  writeFileSync(p.runbook, renderTemplate(readTemplate('lane-management.md'), { containerId: entry.id }));
  addIndexRow(join(p.ai, 'runbooks', 'README.md'), 'lane-management.md', 'How to create, run, monitor and tear down lanes in this container');
  mkdirSync(p.templatesDir, { recursive: true });
  for (const [name, answers] of LANE_TEMPLATES) {
    writeFileSync(join(p.templatesDir, name), readTemplate(name));
    addIndexRow(join(p.templatesDir, 'README.md'), name, answers);
  }
  appendOnce(join(p.ai, 'context', 'README.md'), 'board-note', readTemplate('context-board-note.md'));
  mkdirSync(dirname(p.board), { recursive: true });
  writeFileSync(
    p.board,
    renderBoard({
      container: { id: entry.id, portRange: entry.portRange, hooksPolicy: config.hooks.policy, teardownMcp: config.teardown.mcp },
      state,
    }),
  );

  const block = renderTemplate(readTemplate('lanes-block.md'), { containerId: entry.id });
  for (const a of agents) upsertBlock(join(path, AGENT_FILES[a]), block);
  mergeDenyRules(p.claudeSettings, denyRules());
}

const nextSteps = (path) => [
  `cd ${path}`,
  'Add setup hooks in .laines/hooks/ (post-create, pre-teardown, post-teardown), or let an agent build them: new containers use hook policy "notify".',
  'Create your first lane: laines create',
];

export async function runInit(opts, deps) {
  if (!opts.dir) throw new InvalidInputError('Usage: laines init <dir> --remote <url>');
  if (!opts.remote) throw new InvalidInputError('--remote <url> is required: the git URL every lane clones.');
  const target = resolve(deps.cwd(), opts.dir);
  assertSafeTarget(target, deps.homedir());
  if (opts.id !== undefined) validateId(opts.id);
  const agents = parseAgents(opts.agents);
  const repoName = repoSlugFromRemote(opts.remote);
  const config = buildConfig({ repoName, remote: opts.remote, defaultBranch: opts.branch || 'main', agents });
  const blockSize = config.maxLanes * config.ports.stride;
  const indexDir = configDir(deps.env, deps.homedir());
  const repo = { name: repoName, ...config.repos[repoName] };
  const files = CONTAINER_FILES(agents);

  if (opts.dryRun) {
    const index = loadIndex(indexDir);
    const taken = index.containers.map((c) => c.id);
    if (opts.id !== undefined && taken.includes(opts.id)) {
      throw new InvalidInputError(`Container id "${opts.id}" is already used on this machine. Pick another with --id.`);
    }
    const id = opts.id ?? uniqueId(repoName, taken);
    const portRange = allocateBlock({ range: index.machine.range, blockSize }, index.containers.map((c) => c.portRange));
    return { dryRun: true, id, path: target, portRange, repo, agents, files, next: [] };
  }

  const created = !existsSync(target);
  mkdirSync(target, { recursive: true });
  const path = realpathSync(target);
  let entry;
  try {
    entry = await claimContainer(indexDir, { path, id: opts.id, baseId: repoName, blockSize, now: deps.now() });
  } catch (err) {
    if (created) {
      try {
        rmdirSync(path);
      } catch {}
    }
    throw err;
  }

  try {
    writeContainer({ path, entry, config, agents, deps });
  } catch (err) {
    await releaseContainer(indexDir, entry.id);
    const exitCode = err instanceof LainesError ? err.exitCode : 1;
    throw new LainesError(
      `${err.message}\nContainer setup failed part-way: ${path} may hold partial files. Remove it and run \`laines init\` again.`,
      exitCode,
    );
  }

  appendAudit(containerPaths(path).audit, { ts: deps.now(), action: 'init', container: entry.id }, { warn: deps.warn });
  return { dryRun: false, id: entry.id, path, portRange: entry.portRange, repo, agents, files, next: nextSteps(path) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:run -- test/init.test.js`
Expected: PASS (6 tests). The `dot-ai doctor` assertion in the first test must pass; if it does not, stop and report the doctor output.

- [ ] **Step 5: Commit**

```bash
git add src/deps.js src/lib/audit.js src/commands/init.js test/init.test.js
git commit -m "feat: laines init creates a container"
```

---

### Task 11: CLI wiring, `config get`, container resolution

**Files:**
- Create: `src/lib/container.js`, `src/lib/format.js`, `src/commands/config.js`
- Modify: `src/cli.js` (replace the Task 1 version entirely)
- Test: `test/cli.test.js`

**Interfaces:**
- Consumes: `runInit` (Task 10), `loadConfig` (Task 6), `getPath` (Task 2), `defaultDeps` (Task 10).
- Produces:
  - `resolveContainer(dir) → absolute root` (throws `NotAContainerError`; no upward search)
  - `printJson(value)`, `formatInit(r)`, `formatConfig(r)`, `formatDoctor(r)` (Task 12 uses `formatDoctor`)
  - `runConfigGet({ container?, key? }, deps) → Config | { key, value }`
  - `buildProgram(deps = defaultDeps) → Command` with global `--format` and `--container`; `run(argv, deps = defaultDeps)` (commander usage errors exit 2; `--help`/`--version` exit 0)

- [ ] **Step 1: Write the failing test**

`test/cli.test.js`:
```js
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { runDotAi } from '../src/lib/dotai.js';
import { tmp, cleanupTmp, testDeps } from './helpers.js';

const REMOTE = 'git@example.com:org/my-app.git';

async function cli(args, deps) {
  const out = [];
  const err = [];
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((s) => (err.push(String(s)), true));
  process.exitCode = undefined;
  try {
    await run(['node', 'laines', ...args], deps);
    return { code: process.exitCode ?? 0, stdout: out.join(''), stderr: err.join('') };
  } finally {
    o.mockRestore();
    e.mockRestore();
    process.exitCode = undefined;
  }
}

afterEach(cleanupTmp);

function setup() {
  const root = tmp();
  mkdirSync(join(root, 'home'));
  return { root, deps: testDeps(root, { runDotAi }) };
}

describe('cli', () => {
  it('init prints JSON by default and a table on request', async () => {
    const { deps } = setup();
    const r = await cli(['init', 'lanes', '--remote', REMOTE], deps);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).id).toBe('my-app');
    const t = await cli(['--format', 'table', 'init', 'more', '--remote', REMOTE, '--dry-run'], deps);
    expect(t.code).toBe(0);
    expect(t.stdout).toContain('dry run');
    expect(t.stdout).toContain('my-app-2');
  });

  it('config get reads the whole config or one key, from --container or cwd', async () => {
    const { root, deps } = setup();
    await cli(['init', 'lanes', '--remote', REMOTE], deps);
    const whole = await cli(['--container', join(root, 'lanes'), 'config', 'get'], deps);
    expect(JSON.parse(whole.stdout).maxLanes).toBe(20);
    const inCwd = { ...deps, cwd: () => join(root, 'lanes') };
    const one = await cli(['config', 'get', 'hooks.policy'], inCwd);
    expect(JSON.parse(one.stdout)).toEqual({ key: 'hooks.policy', value: 'notify' });
    const bad = await cli(['config', 'get', 'nope.key'], inCwd);
    expect(bad.code).toBe(2);
  });

  it('maps typed errors and usage errors to exit codes', async () => {
    const { deps } = setup();
    const notContainer = await cli(['config', 'get'], deps);
    expect(notContainer.code).toBe(2);
    expect(notContainer.stderr).toContain('Not a L.AI.nes container');
    const missingRemote = await cli(['init', 'x'], deps);
    expect(missingRemote.code).toBe(2);
    const badFormat = await cli(['--format', 'xml', 'config', 'get'], deps);
    expect(badFormat.code).toBe(2);
    const help = await cli(['--help'], deps);
    expect(help.code).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- test/cli.test.js`
Expected: FAIL — `init` is not a known command / cannot resolve modules.

- [ ] **Step 3: Implement**

`src/lib/container.js`:
```js
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NotAContainerError } from './errors.js';

// No upward search: a command runs against the given directory or fails clearly.
export function resolveContainer(dir) {
  const root = resolve(dir);
  if (existsSync(join(root, '.laines', 'container.json'))) return root;
  throw new NotAContainerError(root);
}
```

`src/lib/format.js`:
```js
export function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

export function formatInit(r) {
  const lines = [
    r.dryRun ? 'dry run: nothing written' : `container ${r.id} created`,
    `id:      ${r.id}`,
    `path:    ${r.path}`,
    `ports:   ${r.portRange[0]}–${r.portRange[1]}`,
    `repo:    ${r.repo.remote} (${r.repo.defaultBranch})`,
    `agents:  ${r.agents.join(', ')}`,
  ];
  if (r.next.length) lines.push('', 'next:', ...r.next.map((s) => `  ${s}`));
  return lines.join('\n');
}

export function formatConfig(r) {
  if (r && Object.prototype.hasOwnProperty.call(r, 'key') && Object.keys(r).length === 2) {
    return `${r.key} = ${typeof r.value === 'object' ? JSON.stringify(r.value) : r.value}`;
  }
  return JSON.stringify(r, null, 2);
}

export function formatDoctor(r) {
  const lines = [];
  if (r.container) lines.push(`container: ${r.container.id ?? '(unknown)'} at ${r.container.path}`);
  for (const c of r.checks) lines.push(`${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  if (r.pruned) lines.push(`pruned: ${r.pruned.length ? r.pruned.map((p) => `${p.id} (${p.path})`).join(', ') : 'nothing'}`);
  lines.push(r.ok ? 'status: ok' : 'status: problems found');
  return lines.join('\n');
}
```

`src/commands/config.js`:
```js
import { loadConfig } from '../config.js';
import { containerPaths } from '../lib/paths.js';
import { resolveContainer } from '../lib/container.js';
import { getPath } from '../lib/jsonfile.js';
import { InvalidInputError } from '../lib/errors.js';

export async function runConfigGet(opts, deps) {
  const root = resolveContainer(opts.container ?? deps.cwd());
  const config = loadConfig(containerPaths(root).config);
  if (!opts.key) return config;
  const value = getPath(config, opts.key);
  if (value === undefined) throw new InvalidInputError(`Unknown config key "${opts.key}".`);
  return { key: opts.key, value };
}
```

`src/cli.js` (replace entirely):
```js
import { Command } from 'commander';
import { defaultDeps } from './deps.js';
import { VERSION } from './version.js';
import { runInit } from './commands/init.js';
import { runConfigGet } from './commands/config.js';
import { EXIT_CODES, InvalidInputError, LainesError } from './lib/errors.js';
import { printJson, formatInit, formatConfig } from './lib/format.js';

// The single choke point: positionals → opts, global options, rendering, error → exit code.
function handle(fn, { table, args } = {}, deps) {
  return async (...actionArgs) => {
    const cmd = actionArgs[actionArgs.length - 1];
    const positionals = actionArgs.slice(0, -2);
    const opts = { ...cmd.opts() };
    (args || []).forEach((name, i) => {
      if (positionals[i] !== undefined) opts[name] = positionals[i];
    });
    let root = cmd;
    while (root.parent) root = root.parent;
    const g = root.opts();
    if (opts.container === undefined) opts.container = g.container;
    try {
      if (!['json', 'table'].includes(g.format)) throw new InvalidInputError(`--format must be json or table (got "${g.format}").`);
      const result = await fn(opts, deps);
      if (g.format === 'table' && table) process.stdout.write(table(result) + '\n');
      else printJson(result);
    } catch (err) {
      process.stderr.write(((err && err.message) || String(err)) + '\n');
      process.exitCode = err instanceof LainesError ? err.exitCode : EXIT_CODES.GENERIC;
    }
  };
}

export function buildProgram(deps = defaultDeps) {
  const program = new Command();
  // exitOverride is inherited by subcommands created after this call.
  program.exitOverride();
  program
    .name('laines')
    .description('L.AI.nes: isolated parallel work lanes for coding agents')
    .version(VERSION)
    .option('--format <format>', 'output format: json|table', 'json')
    .option('--container <dir>', 'container directory (default: current directory)');

  program
    .command('init')
    .description('Create a new L.AI.nes container (shared .ai/ layer, board, lane tooling)')
    .argument('<dir>', 'directory to create the container in')
    .option('--remote <url>', 'git URL every lane clones')
    .option('--id <id>', 'machine-unique container id (default: from the repo name)')
    .option('--agents <list>', 'agents to wire: claude,codex,gemini', 'claude')
    .option('--branch <name>', 'default branch for new lanes', 'main')
    .option('--dry-run', 'show what would be created without writing anything')
    .action(handle(runInit, { table: formatInit, args: ['dir'] }, deps));

  const config = program.command('config').description('Read container settings');
  config
    .command('get')
    .description('Print the container config, or one dotted key')
    .argument('[key]', 'dotted key, e.g. hooks.policy')
    .action(handle(runConfigGet, { table: formatConfig, args: ['key'] }, deps));

  return program;
}

export async function run(argv, deps = defaultDeps) {
  const program = buildProgram(deps);
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err && typeof err.code === 'string' && err.code.startsWith('commander.')) {
      process.exitCode = err.exitCode === 0 ? 0 : EXIT_CODES.CONFIG;
      return;
    }
    throw err;
  }
}
```

Note: `--remote` is an ordinary option (not `requiredOption`) so a missing remote flows through `runInit`'s `InvalidInputError` and exits 2 with a clear message.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:run`
Expected: all test files PASS (smoke test's `--version` still works through `run`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/container.js src/lib/format.js src/commands/config.js src/cli.js test/cli.test.js
git commit -m "feat: cli wiring with init and config get"
```

---

### Task 12: `doctor [--prune]`

**Files:**
- Create: `src/commands/doctor.js`
- Modify: `src/cli.js` (register `doctor`)
- Test: `test/doctor.test.js`

**Interfaces:**
- Consumes: `resolveContainer`, `formatDoctor` (Task 11); `loadConfig` (Task 6); `loadIndex`, `pruneIndex` (Task 5); `readJson` (Task 2); `containerPaths`, `configDir` (Task 4); `AGENT_FILES`, `LANES_BEGIN`, `denyRules` (Task 8); `deps.runDotAi` (Task 10).
- Produces: `runDoctor({ container?, prune? }, deps) → { ok, container: { id, path } | null, checks: [{ name, ok, detail }], pruned?: [{ id, path }] }`. Check names: `container-marker`, `config`, `machine-index`, `dot-ai`, `agent-files`, `deny-rules`, `board`, `lock`. Never throws for a failed check; throws `NotAContainerError` only when not in a container and `--prune` was not given.

- [ ] **Step 1: Write the failing test**

`test/doctor.test.js`:
```js
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.js';
import { runDoctor } from '../src/commands/doctor.js';
import { runDotAi } from '../src/lib/dotai.js';
import { claimContainer, loadIndex } from '../src/lib/machine-index.js';
import { NotAContainerError } from '../src/lib/errors.js';
import { tmp, cleanupTmp, testDeps } from './helpers.js';

afterEach(cleanupTmp);
const REMOTE = 'git@example.com:org/my-app.git';

async function container() {
  const root = tmp();
  mkdirSync(join(root, 'home'));
  const deps = testDeps(root, { runDotAi });
  await runInit({ dir: 'lanes', remote: REMOTE }, deps);
  return { root, deps, c: join(root, 'lanes') };
}

const byName = (r) => Object.fromEntries(r.checks.map((c) => [c.name, c]));

describe('doctor', () => {
  it('passes every check on a fresh container', async () => {
    const { deps, c } = await container();
    const r = await runDoctor({ container: c }, deps);
    expect(r.ok).toBe(true);
    expect(r.container).toEqual({ id: 'my-app', path: c });
    expect(r.checks.map((x) => x.name)).toEqual(['container-marker', 'config', 'machine-index', 'dot-ai', 'agent-files', 'deny-rules', 'board', 'lock']);
  });

  it('reports each broken piece without throwing', async () => {
    const { deps, c } = await container();
    writeFileSync(join(c, 'CLAUDE.md'), 'wiped\n');
    writeFileSync(join(c, '.claude', 'settings.json'), '{}');
    rmSync(join(c, '.ai', 'context', 'LANES_BOARD.md'));
    mkdirSync(join(c, '.laines', '.lock'));
    writeFileSync(join(c, '.laines', 'config.json'), '{ nope');
    const r = await runDoctor({ container: c }, deps);
    expect(r.ok).toBe(false);
    const n = byName(r);
    for (const name of ['config', 'agent-files', 'deny-rules', 'board', 'lock']) expect(n[name].ok, name).toBe(false);
    expect(n.lock.detail).toContain('rmdir');
    expect(n['container-marker'].ok).toBe(true);
  });

  it('flags a container missing from the machine index', async () => {
    const { deps, c } = await container();
    writeFileSync(join(deps.env.LAINES_CONFIG_DIR, 'containers.json'), JSON.stringify({ version: 1, machine: { range: [20000, 29999], blockSize: 200 }, containers: [] }));
    const r = await runDoctor({ container: c }, deps);
    expect(byName(r)['machine-index'].ok).toBe(false);
  });

  it('prunes deleted containers, from anywhere', async () => {
    const { root, deps } = await container();
    await claimContainer(deps.env.LAINES_CONFIG_DIR, { path: join(root, 'deleted'), baseId: 'old', now: 'x' });
    const r = await runDoctor({ container: root, prune: true }, deps);
    expect(r.container).toBeNull();
    expect(r.pruned).toEqual([{ id: 'old', path: join(root, 'deleted') }]);
    expect(loadIndex(deps.env.LAINES_CONFIG_DIR).containers.map((e) => e.id)).toEqual(['my-app']);
  });

  it('refuses outside a container without --prune', async () => {
    const { root, deps } = await container();
    await expect(runDoctor({ container: root }, deps)).rejects.toBeInstanceOf(NotAContainerError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- test/doctor.test.js`
Expected: FAIL — cannot resolve `../src/commands/doctor.js`.

- [ ] **Step 3: Implement**

`src/commands/doctor.js`:
```js
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { readJson } from '../lib/jsonfile.js';
import { configDir, containerPaths } from '../lib/paths.js';
import { loadIndex, pruneIndex } from '../lib/machine-index.js';
import { resolveContainer } from '../lib/container.js';
import { AGENT_FILES, LANES_BEGIN, denyRules } from '../lib/agent-files.js';
import { NotAContainerError } from '../lib/errors.js';

export async function runDoctor(opts, deps) {
  const indexDir = configDir(deps.env, deps.homedir());
  const result = { ok: true, container: null, checks: [] };
  if (opts.prune) result.pruned = (await pruneIndex(indexDir)).map((c) => ({ id: c.id, path: c.path }));

  let root;
  try {
    root = resolveContainer(opts.container ?? deps.cwd());
  } catch (err) {
    if (opts.prune && err instanceof NotAContainerError) return result;
    throw err;
  }
  const p = containerPaths(root);
  const check = (name, fn) => {
    try {
      result.checks.push({ name, ok: true, detail: fn() ?? '' });
    } catch (err) {
      result.ok = false;
      result.checks.push({ name, ok: false, detail: err.message.split('\n')[0] });
    }
  };

  let marker;
  let config;
  check('container-marker', () => {
    marker = readJson(p.marker);
    if (!marker.id) throw new Error(`${p.marker} has no id`);
    return `id ${marker.id}`;
  });
  check('config', () => {
    config = loadConfig(p.config);
    return `repo ${Object.keys(config.repos)[0]}, hook policy ${config.hooks.policy}`;
  });
  check('machine-index', () => {
    const real = realpathSync(root);
    const entry = loadIndex(indexDir).containers.find((c) => c.path === real);
    if (!entry) throw new Error(`not registered in ${join(indexDir, 'containers.json')}`);
    if (marker && entry.id !== marker.id) throw new Error(`index id ${entry.id} does not match marker id ${marker.id}`);
    return `ports ${entry.portRange[0]}–${entry.portRange[1]}`;
  });
  check('dot-ai', () => {
    const r = deps.runDotAi(['doctor'], { cwd: root });
    if (r.error || r.status !== 0) {
      const tail = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-3).join(' | ');
      throw new Error(`dot-ai doctor exit ${r.status}: ${tail}`);
    }
    return '.ai/ layer ok';
  });
  check('agent-files', () => {
    const agents = config ? config.agents : ['claude'];
    const missing = agents.filter((a) => {
      const f = join(root, AGENT_FILES[a]);
      return !existsSync(f) || !readFileSync(f, 'utf8').includes(LANES_BEGIN);
    });
    if (missing.length) throw new Error(`laines-lanes block missing for: ${missing.map((a) => AGENT_FILES[a]).join(', ')}`);
    return agents.map((a) => AGENT_FILES[a]).join(', ');
  });
  check('deny-rules', () => {
    const deny = readJson(p.claudeSettings)?.permissions?.deny ?? [];
    const missing = denyRules().filter((r) => !deny.includes(r));
    if (missing.length) throw new Error(`${missing.length} human-only deny rule(s) missing from .claude/settings.json`);
    return `${denyRules().length} rules present`;
  });
  check('board', () => {
    if (!existsSync(p.board)) throw new Error(`missing ${p.board}`);
    return '.ai/context/LANES_BOARD.md';
  });
  check('lock', () => {
    if (existsSync(p.lock)) throw new Error(`lock held at ${p.lock}; if no laines command is running, remove it: rmdir '${p.lock}'`);
    return 'free';
  });

  result.container = { id: marker?.id ?? null, path: root };
  return result;
}
```

Register in `src/cli.js` — add the import and the command after `config`:
```js
import { runDoctor } from './commands/doctor.js';
import { printJson, formatInit, formatConfig, formatDoctor } from './lib/format.js';
```
```js
  program
    .command('doctor')
    .description('Check the container, its .ai/ layer, agent wiring and the machine index')
    .option('--prune', 'remove machine-index entries whose container no longer exists')
    .action(handle(runDoctor, { table: formatDoctor }, deps));
```
(Replace the existing `format.js` import line rather than adding a second one.)

- [ ] **Step 4: Run all tests and lint**

Run: `npm run test:run && npm run lint`
Expected: all PASS; lint clean.

- [ ] **Step 5: End-to-end check from the real binary**

```bash
E2E=$(mktemp -d)
LAINES_CONFIG_DIR="$E2E/config" node bin/laines.js init "$E2E/lanes" --remote git@example.com:org/demo.git --format table
LAINES_CONFIG_DIR="$E2E/config" node bin/laines.js doctor --container "$E2E/lanes" --format table
```
Expected: init prints `container demo created` with ports `20000–20199`; doctor prints eight `✓` lines and `status: ok`. Leave `$E2E` for the OS to clean up (it is under the temp directory).

- [ ] **Step 6: Commit**

```bash
git add src/commands/doctor.js src/cli.js test/doctor.test.js
git commit -m "feat: laines doctor with machine-index pruning"
```

---

## After M1

- Update `.ai/plans/README.md` if file names changed, and tick M1 in the roadmap.
- Write the M2 (lanes) plan against the code as built.
