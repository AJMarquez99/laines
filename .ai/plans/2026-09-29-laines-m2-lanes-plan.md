# L.AI.nes M2 — Lanes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lanes work end to end from the CLI: `laines create` clones the project into an isolated lane with its own ports, env file, lane-local instructions and git excludes; `list`, `status`, `report`, `brief`, `keep`, `release` and `watch` manage and follow lanes on the board; `teardown` archives, closes and (with `--remove-dir`) deletes a lane only after commit-level unpushed-work and path-containment checks; `doctor` checks every lane.

**Architecture:** Builds on M1's layering (`runXxx(opts, deps)` commands, single `handle()` choke point, typed errors). New shared pieces: `loadContainer` (one canonical container context, lane-mode detection from the lane marker), `updateLanes` (every lane-state change under the container lock, with the board regenerated from `lanes.json`), `containment` (the only code allowed to delete a lane directory), and `lane-files` (lane-local files hidden through `.git/info/exclude`, never overwriting tracked files). Git runs through `deps.git`, never a shell.

**Tech Stack:** Node ≥ 20 (ESM), commander 12, zod 4, vitest 4, the system `git` (≥ 2.28).

**Spec:** `.ai/plans/2026-09-29-laines-spec.md` (§4, §5, §6.2–6.4, §7.1–7.4, §9.1, §9.4, §10.2–10.3, §11). Also read `.ai/notes/m1-deferred-findings.md` (the "Carry into M2" items are implemented here) and `.ai/knowledge/build-constraints.md`.

**Out of scope (later milestones):** hooks (`post-create`, `pre-teardown`, `post-teardown`, `refresh`, `setup-failed`) — M3; MCP server, capabilities (exit 4), locked mode, `teardown.mcp` — M4. Where M3 will insert a hook call, the code carries a one-line `// M3:` comment and nothing else. `doctor`'s per-user setting hints for Codex/Gemini wait for the spec §15 verification (M5); in M2, `agent-reach` only reports which lanes the container instructions reach.

## Global Constraints

- Everything in the M1 plan's Global Constraints still applies (Node `>=20`, ESM, exit codes `0/1/2/3/4`, JSON default with `--format table`, `--dry-run` is a true no-op, commands never print or set `process.exitCode`, `readJson`/`writeJson` for all JSON, no personal data in committed files, tests never touch the real `~/.config`, conventional commits staged by explicit path).
- Every git invocation goes through `deps.git(args, { cwd })` (argument array, no shell). User-supplied values that git could read as options are validated to not start with `-`, and `--` separates options from a remote URL or path.
- Git never prompts: `GIT_TERMINAL_PROMPT=0` is set for every git call.
- Every change to `lanes.json` goes through `updateLanes` (container lock, validated read, validated write, board regenerated). Nothing else writes `lanes.json` or the board.
- A lane directory is deleted only through `removeLaneDir`, which first proves the path is `<container>/<lane>` both lexically and through `realpath`, and is not a symlink.
- Lane-local files never overwrite a file the lane's repository tracks; skipped files are reported as warnings.
- Lane-local files are hidden with `.git/info/exclude`, never the repository's `.gitignore`.
- Human-only commands (`teardown`, `release`) never accept an implicit lane: the lane name is required.
- Global options (`--format`, `--container`) are registered per leaf command through `withGlobals` (M1 rule — `laines --format json teardown` must stay a usage error). `init` gets `--format` only.
- Commit trailer, exactly: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **A project repo that commits its own `.ai/` (a dot-ai project)** — `create` must not overwrite tracked `.ai/README.md`/`.ai/plans/README.md`, and `teardown` must not archive or delete tracked files, leaving `git status` clean — Task 4 and Task 8 pin it.
2. **A lane directory replaced by a symlink pointing outside the container** — `teardown --remove-dir` must refuse with exit 3 and leave the symlink target untouched — Task 8 pins it.
3. **Unpushed work outside branches** (a commit only in `refs/backup/*`, a local tag, a branch with no upstream) — `teardown --remove-dir` must refuse and name the refs — Task 8 pins all three.
4. **A private remote with no credentials** — git must fail instead of hanging on a password prompt — Task 1 pins `GIT_TERMINAL_PROMPT=0`.
5. **A container path containing spaces or shell characters** — the env file must quote values so `source .laines.env` works, and `create` must still clone into it — Task 4 and Task 6 pin it.

---

## File structure (new and changed in M2)

```
src/lib/git.js            (new)  runGit, gitOut
src/lib/netports.js       (new)  busyPorts
src/lib/container.js      (chg)  + findRepoRoot, detectLane, containerDirFrom, loadContainer, laneFrom
src/lib/lanes-store.js    (new)  readLanes, updateLanes, writeBoard (+ activity overflow archive)
src/lib/containment.js    (new)  assertLaneDir, removeLaneDir
src/lib/lane-files.js     (new)  laneEnv, isTracked, upsertExclude, writeLaneFiles, untrackedEntries
src/lib/lane-git.js       (new)  unpushedWork
src/lib/brief.js          (new)  buildBrief
src/lib/board.js          (chg)  export laneBlock
src/lib/errors.js         (chg)  + GitError
src/lib/format.js         (chg)  + formatCreate, formatBrief, formatReport, formatKeep, formatRelease, formatList, formatStatus, formatTeardown
src/commands/create.js    (new)  runCreate
src/commands/brief.js     (new)  runBrief
src/commands/lanes.js     (new)  runReport, runKeep, runRelease, runList, runStatus
src/commands/teardown.js  (new)  runTeardown
src/commands/watch.js     (new)  runWatch, newLines
src/commands/init.js      (chg)  realpath-based ancestor walk
src/commands/config.js    (chg)  containerDirFrom
src/commands/doctor.js    (chg)  containerDirFrom, lane checks, agent reach
src/cli.js                (chg)  withFormat for init, register all M2 commands, reportError helper
src/deps.js               (chg)  + git, busyPorts
templates/lane-local-instructions.md (new)
test/helpers.js           (chg)  + gitIn, makeRemote, setupContainer, runCli; testDeps gains git + busyPorts
README.md                 (chg)  commands table, roadmap
```

---

### Task 1: Git runner, port probe, test fixtures

**Files:**
- Create: `src/lib/git.js`, `src/lib/netports.js`
- Modify: `src/lib/errors.js` (add `GitError`), `src/deps.js`, `test/helpers.js`
- Test: `test/git.test.js`

**Interfaces:**
- Consumes: `LainesError`, `EXIT_CODES` (M1).
- Produces:
  - `runGit(args, { cwd }) → { status: number|null, stdout: string, stderr: string, error?: Error }` (never throws)
  - `gitOut(deps, args, cwd) → string` (stdout; throws `GitError` on non-zero)
  - `class GitError(args, result)` — exit 1, message `git <args[0]> failed (exit N):\n<stderr>`, `.args`
  - `busyPorts([start, end]) → Promise<number[]>` (ports in the range that cannot be bound on 127.0.0.1)
  - `defaultDeps.git = runGit`, `defaultDeps.busyPorts = busyPorts`
  - test helpers: `gitIn(cwd, ...args) → string` (git with a fixed test identity and no global/system config), `makeRemote(root, { files?, branches? }) → string` (bare repo at `<root>/my-app.git` with `main` + branches), `runCli(args, deps) → Promise<{ code, stdout, stderr }>`; `testDeps` now includes `git: runGit` and `busyPorts: async () => []`

- [ ] **Step 1: Write the failing test**

`test/git.test.js`:
```js
import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { runGit, gitOut } from '../src/lib/git.js';
import { busyPorts } from '../src/lib/netports.js';
import { GitError } from '../src/lib/errors.js';
import { tmp, cleanupTmp, testDeps, gitIn, makeRemote } from './helpers.js';

afterEach(cleanupTmp);

describe('runGit', () => {
  it('returns status and output without throwing', () => {
    expect(runGit(['--version']).status).toBe(0);
    expect(runGit(['--version']).stdout).toMatch(/^git version/);
    const bad = runGit(['definitely-not-a-git-command']);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr.length).toBeGreaterThan(0);
  });

  it('never lets git prompt for credentials', () => {
    const r = runGit(['-c', 'alias.promptcheck=!printenv GIT_TERMINAL_PROMPT', 'promptcheck'], { cwd: tmp() });
    expect(r.stdout.trim()).toBe('0');
  });

  it('gitOut returns stdout or throws GitError with the stderr', () => {
    const deps = testDeps(tmp());
    expect(gitOut(deps, ['--version'], tmp())).toMatch(/^git version/);
    try {
      gitOut(deps, ['rev-parse', 'HEAD'], tmp());
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(GitError);
      expect(e.exitCode).toBe(1);
      expect(e.message).toContain('git rev-parse failed');
    }
  });
});

describe('busyPorts', () => {
  it('reports a port something is listening on, and nothing for a free one', async () => {
    const server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      expect(await busyPorts([port, port])).toEqual([port]);
    } finally {
      await new Promise((r) => server.close(r));
    }
    expect(await busyPorts([port, port])).toEqual([]);
  });
});

describe('fixtures', () => {
  it('makeRemote builds a cloneable bare repo with branches', () => {
    const root = tmp();
    const remote = makeRemote(root, { files: { 'a.txt': 'a\n', 'docs/b.md': 'b\n' }, branches: ['feature'] });
    expect(remote).toBe(join(root, 'my-app.git'));
    gitIn(root, 'clone', '-q', remote, join(root, 'check'));
    expect(gitIn(join(root, 'check'), 'ls-files').split('\n')).toEqual(expect.arrayContaining(['a.txt', 'docs/b.md']));
    expect(gitIn(join(root, 'check'), 'branch', '-r')).toContain('origin/feature');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/git.test.js`
Expected: FAIL — cannot resolve `../src/lib/git.js`.

- [ ] **Step 3: Implement**

Append to `src/lib/errors.js`:
```js
export class GitError extends LainesError {
  constructor(args, result) {
    const why = (result.stderr || (result.error && result.error.message) || '').trim();
    super(`git ${args[0]} failed (exit ${result.status ?? 'none'}):\n${why}`, EXIT_CODES.GENERIC);
    this.args = args;
  }
}
```

`src/lib/git.js`:
```js
import { spawnSync } from 'node:child_process';
import { GitError } from './errors.js';

// A lane command must fail, not hang, when a remote needs credentials nobody can type.
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0' };

export function runGit(args, { cwd } = {}) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...GIT_ENV },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

export function gitOut(deps, args, cwd) {
  const r = deps.git(args, { cwd });
  if (r.error || r.status !== 0) throw new GitError(args, r);
  return r.stdout;
}
```

`src/lib/netports.js`:
```js
import { createServer } from 'node:net';

function isFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

export async function busyPorts([start, end]) {
  const busy = [];
  for (let port = start; port <= end; port += 1) {
    if (!(await isFree(port))) busy.push(port);
  }
  return busy;
}
```

`src/deps.js` (replace the file):
```js
import { homedir } from 'node:os';
import { runDotAi } from './lib/dotai.js';
import { runGit } from './lib/git.js';
import { busyPorts } from './lib/netports.js';

// The only place real process state and external programs are wired in. Tests pass their own.
export const defaultDeps = {
  env: process.env,
  homedir: () => homedir(),
  cwd: () => process.cwd(),
  now: () => new Date().toISOString(),
  runDotAi: (args, opts) => runDotAi(args, opts),
  git: (args, opts) => runGit(args, opts),
  busyPorts: (range) => busyPorts(range),
  warn: (msg) => process.stderr.write(`warn: ${msg}\n`),
};
```

`test/helpers.js` (replace the file):
```js
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { vi } from 'vitest';
import { runGit } from '../src/lib/git.js';

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
    git: runGit,
    busyPorts: async () => [],
    warn: () => {},
    ...overrides,
  };
}

// Git for fixtures: fixed identity, and no user/system config (signing, hooks) leaking into tests.
const GIT_TEST_ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

export function gitIn(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...GIT_TEST_ENV } });
}

export function makeRemote(root, { files = { 'README.md': '# app\n' }, branches = [] } = {}) {
  const remote = join(root, 'my-app.git');
  gitIn(root, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = join(root, 'seed');
  gitIn(root, 'init', '-q', '-b', 'main', seed);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(seed, file)), { recursive: true });
    writeFileSync(join(seed, file), content);
  }
  gitIn(seed, 'add', '-A');
  gitIn(seed, 'commit', '-q', '-m', 'init');
  gitIn(seed, 'push', '-q', remote, 'main');
  for (const branch of branches) {
    gitIn(seed, 'checkout', '-q', '-b', branch);
    gitIn(seed, 'commit', '-q', '--allow-empty', '-m', branch);
    gitIn(seed, 'push', '-q', remote, branch);
    gitIn(seed, 'checkout', '-q', 'main');
  }
  return remote;
}

export async function runCli(args, deps) {
  const { run } = await import('../src/cli.js');
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/git.test.js` then `npm run test:run && npm run lint`
Expected: new tests PASS; the whole suite still passes (existing tests don't depend on the new `testDeps` fields).

- [ ] **Step 5: Commit**

```bash
git add src/lib/git.js src/lib/netports.js src/lib/errors.js src/deps.js test/helpers.js test/git.test.js
git commit -m "feat: git runner, port probe and git test fixtures" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Container context and lane detection

**Files:**
- Modify: `src/lib/container.js`, `src/commands/config.js`, `src/commands/doctor.js:18`, `src/commands/init.js` (`assertSafeTarget`), `src/cli.js` (init gets `--format` only), `test/helpers.js` (add `setupContainer`)
- Test: `test/container.test.js`, `test/init.test.js` (one new case)

**Interfaces:**
- Consumes: `resolveContainer` (M1), `loadConfig`, `readJson`, `configDir`, `containerPaths`, `loadIndex`, `runInit`, `runDotAi`, `makeRemote` (Task 1).
- Produces:
  - `findRepoRoot(start) → string|null` (nearest ancestor containing `.git`)
  - `detectLane(start) → { lane, number, containerId, container, root } | null` (spec §7.1: lane marker at the repo root AND the container marker at `container` has the same id)
  - `containerDirFrom(opts, deps) → string` (`--container` resolved against `deps.cwd()` only when relative; else cwd if it is a container; else the container of the lane cwd is in; else cwd)
  - `loadContainer(opts, deps) → { root, paths, id, config, portRange }` (throws `NotAContainerError`, `MalformedConfigError`)
  - `laneFrom(opts, deps) → string` (`opts.lane`, else the lane cwd is in, else `InvalidInputError`)
  - test helper `setupContainer({ files?, branches?, agents?, dir? }) → Promise<{ root, deps, remote, container }>` (real dot-ai, real bare remote)

- [ ] **Step 1: Write the failing tests**

`test/container.test.js`:
```js
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  findRepoRoot, detectLane, containerDirFrom, loadContainer, laneFrom,
} from '../src/lib/container.js';
import { InvalidInputError, MalformedConfigError, NotAContainerError } from '../src/lib/errors.js';
import { tmp, cleanupTmp, testDeps, setupContainer } from './helpers.js';

afterEach(cleanupTmp);

function fakeContainer(root, id = 'app') {
  const c = join(root, 'c');
  mkdirSync(join(c, '.laines'), { recursive: true });
  writeFileSync(join(c, '.laines', 'container.json'), JSON.stringify({ id }));
  return c;
}

function fakeLane(container, name, markerOverrides = {}) {
  const lane = join(container, name);
  mkdirSync(join(lane, '.git'), { recursive: true });
  mkdirSync(join(lane, '.ai'), { recursive: true });
  mkdirSync(join(lane, 'src', 'deep'), { recursive: true });
  writeFileSync(
    join(lane, '.ai', '.lane.json'),
    JSON.stringify({ lane: name, number: 1, containerId: 'app', container, ...markerOverrides }),
  );
  return lane;
}

describe('lane detection', () => {
  it('finds the repo root and the lane from anywhere inside it', () => {
    const c = fakeContainer(tmp());
    const lane = fakeLane(c, 'lane_1');
    expect(findRepoRoot(join(lane, 'src', 'deep'))).toBe(lane);
    expect(detectLane(join(lane, 'src', 'deep'))).toEqual({ lane: 'lane_1', number: 1, containerId: 'app', container: c, root: lane });
  });

  it('is not a lane without a marker, with a mismatched id, or with a missing container', () => {
    const root = tmp();
    const c = fakeContainer(root);
    mkdirSync(join(root, 'plain', '.git'), { recursive: true });
    expect(detectLane(join(root, 'plain'))).toBeNull();
    expect(detectLane(fakeLane(c, 'lane_2', { containerId: 'other' }))).toBeNull();
    expect(detectLane(fakeLane(c, 'lane_3', { container: join(root, 'gone') }))).toBeNull();
    expect(findRepoRoot(tmp())).toBeNull();
  });
});

describe('containerDirFrom', () => {
  it('resolves --container, the cwd container, or the lane container', () => {
    const root = tmp();
    const c = fakeContainer(root);
    const lane = fakeLane(c, 'lane_1');
    expect(containerDirFrom({ container: 'c' }, testDeps(root))).toBe(c);
    const noCwd = testDeps(root, { cwd: () => { throw new Error('cwd must not be read'); } });
    expect(containerDirFrom({ container: c }, noCwd)).toBe(c);
    expect(containerDirFrom({}, testDeps(root, { cwd: () => c }))).toBe(c);
    expect(containerDirFrom({}, testDeps(root, { cwd: () => join(lane, 'src') }))).toBe(c);
    expect(containerDirFrom({}, testDeps(root))).toBe(root);
  });
});

describe('loadContainer and laneFrom', () => {
  it('loads a real container, from the container or from inside a lane dir', async () => {
    const { deps, container } = await setupContainer();
    const ctx = loadContainer({ container }, deps);
    expect(ctx.root).toBe(container);
    expect(ctx.id).toBe('my-app');
    expect(ctx.portRange).toEqual([20000, 20199]);
    expect(ctx.config.lanePrefix).toBe('lane_');
    expect(ctx.paths.board).toBe(join(container, '.ai', 'context', 'LANES_BOARD.md'));
  });

  it('refuses a non-container and an unregistered container', async () => {
    const { root, deps, container } = await setupContainer();
    expect(() => loadContainer({ container: root }, deps)).toThrow(NotAContainerError);
    writeFileSync(join(deps.env.LAINES_CONFIG_DIR, 'containers.json'), JSON.stringify({ version: 1, machine: { range: [20000, 29999], blockSize: 200 }, containers: [] }));
    expect(() => loadContainer({ container }, deps)).toThrow(MalformedConfigError);
  });

  it('laneFrom uses the name, else the lane the cwd is in', () => {
    const c = fakeContainer(tmp());
    const lane = fakeLane(c, 'lane_1');
    expect(laneFrom({ lane: 'x' }, testDeps(c))).toBe('x');
    expect(laneFrom({}, testDeps(c, { cwd: () => lane }))).toBe('lane_1');
    expect(() => laneFrom({}, testDeps(c))).toThrow(InvalidInputError);
  });
});
```

Add to the `cases` table in `test/init.test.js` ("refuses unsafe or occupied targets"), with this setup before the loop:
```js
    mkdirSync(join(root, 'repo', '.git'), { recursive: true });
    mkdirSync(join(root, 'repo', 'sub'), { recursive: true });
    symlinkSync(join(root, 'repo', 'sub'), join(root, 'link'));
```
and this case: `{ dir: 'link/lanes' }` (import `symlinkSync` from `node:fs`). A target reached through a symlink into a repository must be refused. The M1 fix wave may already create `repo/.git` in this test's setup; if so, keep a single `mkdirSync(..., { recursive: true })` for it and only add `repo/sub` and the symlink.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/container.test.js test/init.test.js`
Expected: FAIL — `findRepoRoot` is not exported; `setupContainer` is not exported; the symlink case is accepted.

- [ ] **Step 3: Implement**

`src/lib/container.js` (replace the file):
```js
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { readJson } from './jsonfile.js';
import { configDir, containerPaths } from './paths.js';
import { loadIndex } from './machine-index.js';
import { InvalidInputError, MalformedConfigError, NotAContainerError } from './errors.js';

// No upward search: a command runs against the given directory or fails clearly.
export function resolveContainer(dir) {
  const root = resolve(dir);
  if (existsSync(join(root, '.laines', 'container.json'))) return realpathSync(root);
  throw new NotAContainerError(root);
}

export function findRepoRoot(start) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

const readJsonQuiet = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// Spec §7.1: lane mode only when the lane marker sits at the repo root AND the container it names
// carries a marker with the same id. The container is never searched for.
export function detectLane(start) {
  const root = findRepoRoot(start);
  if (!root) return null;
  const m = readJsonQuiet(join(root, '.ai', '.lane.json'));
  if (!m || typeof m.lane !== 'string' || typeof m.container !== 'string' || typeof m.containerId !== 'string') return null;
  const c = readJsonQuiet(join(m.container, '.laines', 'container.json'));
  if (!c || c.id !== m.containerId) return null;
  return { lane: m.lane, number: m.number, containerId: m.containerId, container: m.container, root };
}

export function containerDirFrom(opts, deps) {
  if (opts.container) return isAbsolute(opts.container) ? opts.container : resolve(deps.cwd(), opts.container);
  const cwd = deps.cwd();
  if (existsSync(join(cwd, '.laines', 'container.json'))) return cwd;
  const lane = detectLane(cwd);
  return lane ? lane.container : cwd;
}

export function loadContainer(opts, deps) {
  const root = resolveContainer(containerDirFrom(opts, deps));
  const paths = containerPaths(root);
  const marker = readJson(paths.marker);
  if (!marker.id) throw new MalformedConfigError(paths.marker, 'no id');
  const config = loadConfig(paths.config);
  const indexDir = configDir(deps.env, deps.homedir());
  const entry = loadIndex(indexDir).containers.find((c) => c.path === root);
  if (!entry) {
    throw new MalformedConfigError(join(indexDir, 'containers.json'), `container ${root} is not registered; run \`laines doctor\``);
  }
  return { root, paths, id: marker.id, config, portRange: entry.portRange };
}

export function laneFrom(opts, deps) {
  if (opts.lane) return opts.lane;
  const lane = detectLane(deps.cwd());
  if (lane) return lane.lane;
  throw new InvalidInputError('Name the lane (for example `laines report lane_2 ...`) or run the command inside a lane.');
}
```

`src/commands/config.js` — replace the `resolveContainer(...)` line so it reads:
```js
  const root = resolveContainer(containerDirFrom(opts, deps));
```
and import `containerDirFrom` alongside `resolveContainer` from `../lib/container.js` (drop the now-unused `resolve` import if present).

`src/commands/doctor.js:18` — replace `resolveContainer(resolve(deps.cwd(), opts.container ?? '.'))` with `resolveContainer(containerDirFrom(opts, deps))`, import `containerDirFrom`, and drop `resolve` from the `node:path` import.

`src/commands/init.js` — replace the ancestor loop in `assertSafeTarget` with a walk over the real path (add `relative` to the `node:path` import):
```js
  // Walk the real path: a symlink into a repository or container must not slip through.
  let existing = target;
  while (!existsSync(existing)) existing = dirname(existing);
  const real = join(realpathSync(existing), relative(existing, target));
  for (let dir = real; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) {
      throw new InvalidInputError(
        `${target} is inside the git repository ${dir}. Create the container outside any repository; lanes are the clones.`,
      );
    }
    if (dir !== real && existsSync(join(dir, '.laines', 'container.json'))) {
      throw new InvalidInputError(`${target} is inside the container ${dir}. Create containers outside other containers.`);
    }
    if (dirname(dir) === dir) break;
  }
```

`src/cli.js` — `init` must not accept `--container`. Add next to `withGlobals`:
```js
const withFormat = (cmd) => cmd.option('--format <format>', 'output format: json|table', 'json');
```
and change `withGlobals(program.command('init'))` to `withFormat(program.command('init'))`.

`test/helpers.js` — add (and import `runInit` from `../src/commands/init.js` and `runDotAi` from `../src/lib/dotai.js` at the top):
```js
export async function setupContainer({ files, branches, agents, dir = 'lanes' } = {}) {
  const root = tmp();
  mkdirSync(join(root, 'home'));
  const deps = testDeps(root, { runDotAi });
  const remote = makeRemote(root, { files, branches });
  const r = await runInit({ dir, remote, ...(agents ? { agents } : {}) }, deps);
  return { root, deps, remote, container: r.path };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/container.test.js test/init.test.js` then `npm run test:run && npm run lint`
Expected: PASS, full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/container.js src/commands/config.js src/commands/doctor.js src/commands/init.js src/cli.js test/helpers.js test/container.test.js test/init.test.js
git commit -m "feat: container context, lane detection, realpath-safe init" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Lane state store

**Files:**
- Create: `src/lib/lanes-store.js`
- Modify: `src/lib/board.js` (export `laneBlock`)
- Test: `test/lanes-store.test.js`

**Interfaces:**
- Consumes: `withLock` (M1), `readJson`/`writeJson`, `parseLanesState`, `emptyLanesState`, `addActivity`, `renderBoard`, `fmtTs`, `oneLine`, `buildConfig`, `containerPaths`.
- Produces:
  - `readLanes(ctx) → LanesState` (ctx needs only `paths`)
  - `writeBoard(ctx, state) → void`
  - `updateLanes(ctx, deps, mutate) → Promise<result>` where `mutate(stateCopy) → { state, result, activity?: [{ ts, lane, text }] } | Promise<same>`; runs under `ctx.paths.lock`; validates the new state before writing; appends activity (newest first) capped at `ctx.config.board.logLimit`, overflow appended to `<ctx.paths.ai>/archive/<YYYY-MM-DD>_board-log.md` (date from `deps.now()`); regenerates the board. If `mutate` throws, nothing is written.
  - `laneBlock(name, lane) → string` now exported from `src/lib/board.js`
- `ctx` shape (from Task 2's `loadContainer`): `{ root, paths, id, config, portRange }`.

- [ ] **Step 1: Write the failing test**

`test/lanes-store.test.js`:
```js
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLanes, updateLanes } from '../src/lib/lanes-store.js';
import { buildConfig } from '../src/config.js';
import { containerPaths } from '../src/lib/paths.js';
import { MalformedConfigError } from '../src/lib/errors.js';
import { tmp, cleanupTmp, testDeps } from './helpers.js';

afterEach(cleanupTmp);

function ctxFor(root, logLimit = 200) {
  const config = buildConfig({ repoName: 'app', remote: 'git@example.com:o/app.git', defaultBranch: 'main', agents: ['claude'] });
  config.board.logLimit = logLimit;
  return { root, paths: containerPaths(root), id: 'app', config, portRange: [20000, 20199] };
}

const lane = (n, over = {}) => ({
  number: n,
  repos: [{ name: 'app', path: `lane_${n}`, branch: 'main' }],
  ports: [20000 + (n - 1) * 10, 20009 + (n - 1) * 10],
  state: 'active',
  status: 'idle',
  task: null,
  blocked: null,
  kept: null,
  created: '2026-09-29T12:00:00.000Z',
  updated: '2026-09-29T12:00:00.000Z',
  closed: null,
  ...over,
});

describe('lanes store', () => {
  it('reads an empty state, writes lanes.json and regenerates the board', async () => {
    const root = tmp();
    const ctx = ctxFor(root);
    const deps = testDeps(root);
    expect(readLanes(ctx).lanes).toEqual({});
    const r = await updateLanes(ctx, deps, (s) => {
      s.lanes.lane_1 = lane(1);
      return { state: s, result: 'ok', activity: [{ ts: deps.now(), lane: 'lane_1', text: 'created' }] };
    });
    expect(r).toBe('ok');
    expect(readLanes(ctx).lanes.lane_1.number).toBe(1);
    const board = readFileSync(ctx.paths.board, 'utf8');
    expect(board).toContain('<!-- lane:lane_1:start -->');
    expect(board).toContain('`lane_1`: created');
    expect(existsSync(ctx.paths.lock)).toBe(false);
  });

  it('writes nothing when mutate throws or returns an invalid state', async () => {
    const root = tmp();
    const ctx = ctxFor(root);
    const deps = testDeps(root);
    await updateLanes(ctx, deps, (s) => ({ state: s, result: null }));
    const before = readFileSync(ctx.paths.lanes, 'utf8');
    await expect(updateLanes(ctx, deps, () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(updateLanes(ctx, deps, (s) => {
      s.lanes.bad = { number: 'x' };
      return { state: s, result: null };
    })).rejects.toBeInstanceOf(MalformedConfigError);
    expect(readFileSync(ctx.paths.lanes, 'utf8')).toBe(before);
    expect(existsSync(ctx.paths.lock)).toBe(false);
  });

  it('rolls activity beyond logLimit into the dated archive file', async () => {
    const root = tmp();
    const ctx = ctxFor(root, 10);
    const deps = testDeps(root);
    const entries = Array.from({ length: 12 }, (_, i) => ({ ts: `2026-09-29T12:${String(i).padStart(2, '0')}:00.000Z`, lane: null, text: `e${i + 1}` }));
    await updateLanes(ctx, deps, (s) => ({ state: s, result: null, activity: entries }));
    const state = readLanes(ctx);
    expect(state.activity).toHaveLength(10);
    expect(state.activity[0].text).toBe('e12');
    const archive = readFileSync(join(ctx.paths.ai, 'archive', '2026-09-29_board-log.md'), 'utf8');
    expect(archive).toContain('# Board activity archive: app');
    expect(archive).toContain('e1');
    expect(archive).toContain('e2');
    expect(archive).not.toContain('e3\n');
  });

  it('serialises concurrent updates without losing any', async () => {
    const root = tmp();
    const ctx = ctxFor(root);
    const deps = testDeps(root);
    await Promise.all([1, 2, 3, 4].map((n) => updateLanes(ctx, deps, (s) => {
      s.lanes[`lane_${n}`] = lane(n);
      return { state: s, result: null };
    })));
    expect(Object.keys(readLanes(ctx).lanes).sort()).toEqual(['lane_1', 'lane_2', 'lane_3', 'lane_4']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lanes-store.test.js`
Expected: FAIL — cannot resolve `../src/lib/lanes-store.js`.

- [ ] **Step 3: Implement**

`src/lib/board.js` — change `function laneBlock(name, lane)` to `export function laneBlock(name, lane)`.

`src/lib/lanes-store.js`:
```js
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJson, writeJson } from './jsonfile.js';
import { withLock } from './lock.js';
import { addActivity, emptyLanesState, parseLanesState } from './lanes-state.js';
import { fmtTs, oneLine, renderBoard } from './board.js';

export const readLanes = (ctx) => parseLanesState(readJson(ctx.paths.lanes, { onMissing: emptyLanesState }), ctx.paths.lanes);

export function writeBoard(ctx, state) {
  mkdirSync(dirname(ctx.paths.board), { recursive: true });
  const container = {
    id: ctx.id,
    portRange: ctx.portRange,
    hooksPolicy: ctx.config.hooks.policy,
    teardownMcp: ctx.config.teardown.mcp,
  };
  writeFileSync(ctx.paths.board, renderBoard({ container, state }));
}

function archiveOverflow(ctx, overflow, now) {
  if (!overflow.length) return;
  const file = join(ctx.paths.ai, 'archive', `${now.slice(0, 10)}_board-log.md`);
  mkdirSync(dirname(file), { recursive: true });
  const head = existsSync(file)
    ? ''
    : `# Board activity archive: ${ctx.id}\n\n_Entries rolled off the board's Activity Log, newest first within each batch._\n\n`;
  const lines = overflow.map((a) => `- **${fmtTs(a.ts)}** · ${a.lane ? `\`${a.lane}\`: ` : ''}${oneLine(a.text)}`);
  appendFileSync(file, `${head}${lines.join('\n')}\n`);
}

// Every lane-state change goes through here: one lock, one validated read, one validated write of
// lanes.json, and a board regenerated from the result. If mutate throws, nothing is written.
export async function updateLanes(ctx, deps, mutate) {
  return withLock(ctx.paths.lock, async () => {
    const current = readLanes(ctx);
    const { state, result, activity = [] } = await mutate(structuredClone(current));
    let next = parseLanesState(state, ctx.paths.lanes);
    for (const entry of activity) {
      const r = addActivity(next, entry, ctx.config.board.logLimit);
      next = r.state;
      archiveOverflow(ctx, r.overflow, deps.now());
    }
    writeJson(ctx.paths.lanes, next);
    writeBoard(ctx, next);
    return result;
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lanes-store.test.js` then `npm run test:run && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/lanes-store.js src/lib/board.js test/lanes-store.test.js
git commit -m "feat: locked lane-state store with board regeneration" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Containment and lane-local files

**Files:**
- Create: `src/lib/containment.js`, `src/lib/lane-files.js`, `templates/lane-local-instructions.md`
- Test: `test/containment.test.js`, `test/lane-files.test.js`

**Interfaces:**
- Consumes: `BlockedError`, `gitOut` (Task 1), `readJson`/`writeJson`, `readTemplate`/`renderTemplate`, `mergeDenyRules`/`denyRules`, `laneId`/`laneSuffix`/`composeProject` (M1), `ctx` (Task 2 shape).
- Produces:
  - `assertLaneDir(root, laneDir, name) → string|null` — realpath of the lane dir, `null` if it doesn't exist; throws `BlockedError` unless the path is `<root>/<name>` lexically AND by realpath and is not a symlink. `root` must be a realpath.
  - `removeLaneDir(root, laneDir, name) → boolean` (true if something was deleted)
  - `LANE_EXCLUDES: string[]`, `EXCLUDE_BEGIN`, `EXCLUDE_END`
  - `laneEnv({ lane, number, containerId, laneDir, containerDir, ports, branch }) → string` (double-quoted, escaped values)
  - `isTracked(deps, repoDir, rel) → boolean`
  - `upsertExclude(deps, laneDir) → void` (idempotent marked block in `$(git rev-parse --git-path info/exclude)`)
  - `untrackedEntries(deps, repoDir, relDir) → string[]` (top-level entry names under `relDir` that contain no tracked file)
  - `writeLaneFiles(ctx, deps, { name, number, laneDir, branch, ports }) → { written: string[], skipped: [{ file, reason }] }`

- [ ] **Step 1: Write the template**

`templates/lane-local-instructions.md`:
```markdown
# Lane `{{lane}}` of L.AI.nes container `{{containerId}}`

You are working in a lane: an isolated clone with its own ports and local environment.

- Lane ID: `{{laneId}}`; created on branch `{{branch}}`.
- Ports: {{portStart}}–{{portEnd}}. Source `.laines.env` in this directory before starting services.
- Shared knowledge lives in `{{containerDir}}/.ai/`. Read its `knowledge/`, `guidelines/` and
  `lessons/`, and write durable findings there, not into this lane.
- This lane owns only `.ai/context/` and `.ai/plans/`. Never run `dot-ai init` or `dot-ai sync` here.
- Report status with `laines report {{lane}} --status "..." --task "..."`. The board is
  `{{containerDir}}/.ai/context/LANES_BOARD.md`.
- Teardown, release, hook approval, hook policy and config changes are for a human.

Full protocol: `{{containerDir}}/.ai/runbooks/lane-management.md`
```

- [ ] **Step 2: Write the failing tests**

`test/containment.test.js`:
```js
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertLaneDir, removeLaneDir } from '../src/lib/containment.js';
import { BlockedError } from '../src/lib/errors.js';
import { tmp, cleanupTmp } from './helpers.js';

afterEach(cleanupTmp);

describe('containment', () => {
  it('accepts <root>/<name> and removes it', () => {
    const root = tmp();
    mkdirSync(join(root, 'lane_1', 'x'), { recursive: true });
    expect(assertLaneDir(root, join(root, 'lane_1'), 'lane_1')).toBe(join(root, 'lane_1'));
    expect(removeLaneDir(root, join(root, 'lane_1'), 'lane_1')).toBe(true);
    expect(existsSync(join(root, 'lane_1'))).toBe(false);
    expect(assertLaneDir(root, join(root, 'lane_1'), 'lane_1')).toBeNull();
    expect(removeLaneDir(root, join(root, 'lane_1'), 'lane_1')).toBe(false);
  });

  it('refuses anything else, and never touches a symlink target', () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, 'keep.txt'), 'x');
    symlinkSync(outside, join(root, 'lane_2'));
    mkdirSync(join(root, 'nested', 'lane_3'), { recursive: true });
    const cases = [
      [join(root, 'lane_2'), 'lane_2'],
      [join(root, 'nested', 'lane_3'), 'lane_3'],
      [join(root, 'lane_1'), 'lane_9'],
      [root, 'lane_1'],
      [join(root, '..'), '..'],
    ];
    for (const [dir, name] of cases) {
      expect(() => removeLaneDir(root, dir, name), `${dir} ${name}`).toThrow(BlockedError);
    }
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
  });
});
```

`test/lane-files.test.js`:
```js
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  laneEnv, writeLaneFiles, isTracked, untrackedEntries, EXCLUDE_BEGIN,
} from '../src/lib/lane-files.js';
import { buildConfig } from '../src/config.js';
import { containerPaths } from '../src/lib/paths.js';
import { denyRules } from '../src/lib/agent-files.js';
import { tmp, cleanupTmp, testDeps, gitIn, makeRemote } from './helpers.js';

afterEach(cleanupTmp);

function setup({ files, agents = ['claude', 'codex'] } = {}) {
  const root = tmp();
  const remote = makeRemote(root, { files });
  const container = join(root, 'c');
  mkdirSync(container);
  const laneDir = join(container, 'lane_2');
  gitIn(root, 'clone', '-q', remote, laneDir);
  const config = buildConfig({ repoName: 'my-app', remote, defaultBranch: 'main', agents });
  const ctx = { root: container, paths: containerPaths(container), id: 'my-app', config, portRange: [20000, 20199] };
  return { ctx, deps: testDeps(root), lane: { name: 'lane_2', number: 2, laneDir, branch: 'main', ports: [20010, 20019] } };
}

describe('laneEnv', () => {
  it('writes every variable, quoted so paths with spaces and shell characters survive source', () => {
    const env = laneEnv({ lane: 'lane_2', number: 2, containerId: 'my-app', laneDir: '/tmp/my lanes/lane_2', containerDir: '/tmp/my lanes', ports: [20010, 20019], branch: 'feat/$x' });
    expect(env).toContain('LANE_SUFFIX="_my_app_l2"');
    expect(env).toContain('COMPOSE_PROJECT_NAME="my-app-l2"');
    expect(env).toContain('PORT="20010"');
    expect(env).toContain('LANE_PORT_COUNT="10"');
    expect(env).toContain('LANE_ID="my-app/lane_2"');
    expect(env).toContain('LANE_ENV_FILE="/tmp/my lanes/lane_2/.laines.env"');
    expect(env).toContain('LANE_BRANCH="feat/\\$x"');
    const out = execFileSync('sh', ['-c', `set -a; . /dev/stdin; printf '%s|%s' "$LANE_DIR" "$LANE_BRANCH"`], { input: env, encoding: 'utf8' });
    expect(out).toBe('/tmp/my lanes/lane_2|feat/$x');
  });
});

describe('writeLaneFiles', () => {
  it('writes lane-local files hidden from git, with deny rules and plansDirectory', () => {
    const { ctx, deps, lane } = setup();
    const r = writeLaneFiles(ctx, deps, lane);
    expect(r.skipped).toEqual([]);
    for (const f of ['.ai/.lane.json', '.ai/README.md', '.ai/context/README.md', '.ai/plans/README.md', '.laines.env', 'CLAUDE.local.md', 'AGENTS.md', '.claude/settings.local.json']) {
      expect(existsSync(join(lane.laneDir, f)), f).toBe(true);
      expect(r.written).toContain(f);
    }
    expect(gitIn(lane.laneDir, 'status', '--porcelain')).toBe('');
    expect(JSON.parse(readFileSync(join(lane.laneDir, '.ai', '.lane.json'), 'utf8'))).toEqual({ lane: 'lane_2', number: 2, containerId: 'my-app', container: ctx.root });
    expect(readFileSync(join(lane.laneDir, '.ai', 'README.md'), 'utf8')).toContain(`${ctx.root}/.ai/`);
    expect(readFileSync(join(lane.laneDir, 'CLAUDE.local.md'), 'utf8')).toContain('Ports: 20010–20019');
    const settings = JSON.parse(readFileSync(join(lane.laneDir, '.claude', 'settings.local.json'), 'utf8'));
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(denyRules()));
    expect(settings.plansDirectory).toBe('.ai/plans');
  });

  it('is idempotent: one exclude block, no duplicate deny rules', () => {
    const { ctx, deps, lane } = setup();
    writeLaneFiles(ctx, deps, lane);
    writeLaneFiles(ctx, deps, lane);
    const exclude = readFileSync(join(lane.laneDir, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split(EXCLUDE_BEGIN)).toHaveLength(2);
    const settings = JSON.parse(readFileSync(join(lane.laneDir, '.claude', 'settings.local.json'), 'utf8'));
    expect(settings.permissions.deny).toHaveLength(denyRules().length);
  });

  it('never overwrites files the repository tracks, and reports them', () => {
    const { ctx, deps, lane } = setup({ files: { 'README.md': 'x\n', '.ai/README.md': 'project ai readme\n', '.ai/plans/README.md': 'project plans\n', 'AGENTS.md': 'project agents\n' } });
    const r = writeLaneFiles(ctx, deps, lane);
    expect(r.skipped.map((s) => s.file).sort()).toEqual(['.ai/README.md', '.ai/plans/README.md', 'AGENTS.md']);
    expect(readFileSync(join(lane.laneDir, '.ai', 'README.md'), 'utf8')).toBe('project ai readme\n');
    expect(readFileSync(join(lane.laneDir, 'AGENTS.md'), 'utf8')).toBe('project agents\n');
    expect(gitIn(lane.laneDir, 'status', '--porcelain')).toBe('');
    expect(isTracked(deps, lane.laneDir, '.ai/plans/README.md')).toBe(true);
    expect(isTracked(deps, lane.laneDir, '.ai/context/README.md')).toBe(false);
    expect(untrackedEntries(deps, lane.laneDir, '.ai/plans')).toEqual([]);
    expect(untrackedEntries(deps, lane.laneDir, '.ai/context')).toEqual(['README.md']);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/containment.test.js test/lane-files.test.js`
Expected: FAIL — cannot resolve the new modules.

- [ ] **Step 4: Implement**

`src/lib/containment.js`:
```js
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { BlockedError } from './errors.js';

// Spec §9.1: before anything under a lane is touched destructively, the path must be
// <container>/<lane> both lexically and through realpath, and must not be a symlink.
// `root` must already be a realpath (loadContainer guarantees it).
export function assertLaneDir(root, laneDir, name) {
  const lexical = resolve(laneDir);
  const refuse = (why) => {
    throw new BlockedError(`Refusing to touch ${lexical}: ${why}.`);
  };
  if (dirname(lexical) !== root || basename(lexical) !== name) refuse(`it is not ${name}/ directly inside the container ${root}`);
  if (!existsSync(lexical)) return null;
  if (lstatSync(lexical).isSymbolicLink()) refuse('it is a symbolic link');
  const real = realpathSync(lexical);
  if (dirname(real) !== root || basename(real) !== name) refuse(`it resolves to ${real}, outside the container`);
  return real;
}

export function removeLaneDir(root, laneDir, name) {
  const real = assertLaneDir(root, laneDir, name);
  if (!real) return false;
  rmSync(real, { recursive: true, force: true });
  return true;
}
```

`src/lib/lane-files.js`:
```js
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { gitOut } from './git.js';
import { readJson, writeJson } from './jsonfile.js';
import { readTemplate, renderTemplate } from './templates.js';
import { denyRules, mergeDenyRules } from './agent-files.js';
import { composeProject, laneId, laneSuffix } from './ids.js';

export const EXCLUDE_BEGIN = '# BEGIN laines lane (lane-local files, never committed)';
export const EXCLUDE_END = '# END laines lane';
export const LANE_EXCLUDES = [
  '/.ai/.lane.json',
  '/.ai/README.md',
  '/.ai/context/',
  '/.ai/plans/',
  '/.laines.env',
  '/CLAUDE.local.md',
  '/AGENTS.md',
  '/GEMINI.md',
  '/.claude/settings.local.json',
];

// Double-quoted and escaped, so `source .laines.env` survives spaces and shell characters.
const q = (value) => `"${String(value).replace(/[\\"$`]/g, (c) => `\\${c}`)}"`;

export function laneEnv({ lane, number, containerId, laneDir, containerDir, ports, branch }) {
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
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${q(v)}`);
  return `# Generated by laines for lane ${lane}. Source it before starting services.\n${lines.join('\n')}\n`;
}

export const isTracked = (deps, repoDir, rel) =>
  deps.git(['ls-files', '--error-unmatch', '--', rel], { cwd: repoDir }).status === 0;

export function upsertExclude(deps, laneDir) {
  const rel = gitOut(deps, ['rev-parse', '--git-path', 'info/exclude'], laneDir).trim();
  const file = isAbsolute(rel) ? rel : join(laneDir, rel);
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const block = [EXCLUDE_BEGIN, ...LANE_EXCLUDES, EXCLUDE_END].join('\n');
  const b = cur.indexOf(EXCLUDE_BEGIN);
  const e = cur.indexOf(EXCLUDE_END);
  const next = b !== -1 && e > b
    ? cur.slice(0, b) + block + cur.slice(e + EXCLUDE_END.length)
    : `${cur ? cur.replace(/\n*$/, '\n\n') : ''}${block}\n`;
  if (next === cur) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
}

// Top-level entries of relDir that hold no tracked file: the lane's own, safe to move or delete.
export function untrackedEntries(deps, repoDir, relDir) {
  const dir = join(repoDir, relDir);
  if (!existsSync(dir)) return [];
  const isRepo = existsSync(join(repoDir, '.git'));
  const tracked = isRepo ? gitOut(deps, ['ls-files', '--', relDir], repoDir).split('\n').filter(Boolean) : [];
  return readdirSync(dir)
    .filter((entry) => {
      const rel = `${relDir}/${entry}`;
      return !tracked.some((t) => t === rel || t.startsWith(`${rel}/`));
    })
    .sort();
}

// Spec §4. Never overwrites a file the repository tracks: a lane must not change project files
// behind the developer's back. Those are skipped and reported.
export function writeLaneFiles(ctx, deps, lane) {
  const { name, number, laneDir, branch, ports } = lane;
  const vars = {
    lane: name,
    laneId: laneId(ctx.id, name),
    containerId: ctx.id,
    containerDir: ctx.root,
    branch,
    portStart: ports[0],
    portEnd: ports[1],
  };
  const written = [];
  const skipped = [];
  upsertExclude(deps, laneDir); // first, so nothing written below ever shows in git status
  mkdirSync(join(laneDir, '.ai', 'context'), { recursive: true });
  mkdirSync(join(laneDir, '.ai', 'plans'), { recursive: true });

  const tracked = (rel) => {
    if (!isTracked(deps, laneDir, rel)) return false;
    skipped.push({ file: rel, reason: 'tracked by the repository' });
    return true;
  };
  const put = (rel, content) => {
    if (tracked(rel)) return;
    const file = join(laneDir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    written.push(rel);
  };
  // The container's copies of the lane templates win, so a team can customise them.
  const template = (file) => {
    const own = join(ctx.paths.templatesDir, file);
    return renderTemplate(existsSync(own) ? readFileSync(own, 'utf8') : readTemplate(file), vars);
  };

  put('.ai/.lane.json', `${JSON.stringify({ lane: name, number, containerId: ctx.id, container: ctx.root }, null, 2)}\n`);
  put('.ai/README.md', template('lane-ai-readme.md'));
  put('.ai/context/README.md', template('lane-context-readme.md'));
  put('.ai/plans/README.md', template('lane-plans-readme.md'));
  put('.laines.env', laneEnv({ lane: name, number, containerId: ctx.id, laneDir, containerDir: ctx.root, ports, branch }));

  const local = renderTemplate(readTemplate('lane-local-instructions.md'), vars);
  const agents = ctx.config.agents;
  if (agents.includes('claude')) {
    put('CLAUDE.local.md', local);
    const rel = '.claude/settings.local.json';
    if (!tracked(rel)) {
      const file = join(laneDir, rel);
      mergeDenyRules(file, denyRules());
      const data = readJson(file);
      if (data.plansDirectory === undefined) writeJson(file, { ...data, plansDirectory: '.ai/plans' });
      written.push(rel);
    }
  }
  if (agents.includes('codex')) put('AGENTS.md', local);
  if (agents.includes('gemini')) put('GEMINI.md', local);
  return { written, skipped };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/containment.test.js test/lane-files.test.js` then `npm run test:run && npm run lint`
Expected: PASS. The M1 template test in `test/agent-files.test.js` still passes (it lists specific templates; the new one is not in its list).

- [ ] **Step 6: Commit**

```bash
git add src/lib/containment.js src/lib/lane-files.js templates/lane-local-instructions.md test/containment.test.js test/lane-files.test.js
git commit -m "feat: lane path containment and lane-local files" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `brief`

**Files:**
- Create: `src/lib/brief.js`, `src/commands/brief.js`
- Modify: `src/lib/format.js` (add `formatBrief`), `src/cli.js` (register `brief`)
- Test: `test/brief.test.js`

**Interfaces:**
- Consumes: `loadContainer`, `laneFrom` (Task 2), `readLanes`, `updateLanes` (Task 3), `laneBlock` (Task 3), `laneId` (M1).
- Produces:
  - `buildBrief(ctx, name, lane) → { lane, id, path, branch, ports, envFile, readFirst: [{ path, why }], rules: string[], board: string, text: string }` — `readFirst` lists only paths that exist.
  - `runBrief({ lane?, container? }, deps) → Brief` (unknown or closed lane → `InvalidInputError`)
  - `formatBrief(r) → r.text`
  - CLI: `laines brief [lane]` (with `--format`, `--container`)

- [ ] **Step 1: Write the failing test**

`test/brief.test.js`:
```js
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBrief } from '../src/lib/brief.js';
import { runBrief } from '../src/commands/brief.js';
import { loadContainer } from '../src/lib/container.js';
import { updateLanes } from '../src/lib/lanes-store.js';
import { InvalidInputError } from '../src/lib/errors.js';
import { cleanupTmp, setupContainer, runCli } from './helpers.js';

afterEach(cleanupTmp);

const record = (over = {}) => ({
  number: 1,
  repos: [{ name: 'my-app', path: 'lane_1', branch: 'feat/x' }],
  ports: [20000, 20009],
  state: 'active',
  status: 'in-progress',
  task: 'webhooks',
  blocked: null,
  kept: null,
  created: '2026-09-29T12:00:00.000Z',
  updated: '2026-09-29T12:00:00.000Z',
  closed: null,
  ...over,
});

async function withLane(over) {
  const s = await setupContainer();
  const ctx = loadContainer({ container: s.container }, s.deps);
  await updateLanes(ctx, s.deps, (state) => {
    state.lanes.lane_1 = record(over);
    return { state, result: null };
  });
  const laneDir = join(s.container, 'lane_1');
  mkdirSync(join(laneDir, '.git'), { recursive: true });
  mkdirSync(join(laneDir, '.ai', 'context'), { recursive: true });
  writeFileSync(join(laneDir, 'CLAUDE.md'), 'repo rules\n');
  writeFileSync(join(laneDir, '.ai', '.lane.json'), JSON.stringify({ lane: 'lane_1', number: 1, containerId: 'my-app', container: s.container }));
  return { ...s, ctx, laneDir };
}

describe('brief', () => {
  it('lists existing files to read, the rules and the board entry', async () => {
    const { ctx, container, laneDir } = await withLane();
    const b = buildBrief(ctx, 'lane_1', record());
    expect(b).toMatchObject({ lane: 'lane_1', id: 'my-app/lane_1', path: laneDir, branch: 'feat/x', ports: [20000, 20009], envFile: join(laneDir, '.laines.env') });
    const paths = b.readFirst.map((r) => r.path);
    expect(paths).toContain(join(laneDir, 'CLAUDE.md'));
    expect(paths).toContain(join(laneDir, '.ai', 'context'));
    expect(paths).toContain(join(container, '.ai', 'knowledge'));
    expect(paths).not.toContain(join(laneDir, 'AGENTS.md'));
    expect(b.rules.join('\n')).toContain('20000–20009');
    expect(b.rules.join('\n')).toContain('laines report lane_1');
    expect(b.board).toContain('<!-- lane:lane_1:start -->');
    expect(b.text).toContain('# Lane brief: lane_1 (my-app/lane_1)');
  });

  it('runs by name or from inside the lane, and refuses unknown or closed lanes', async () => {
    const { deps, container, laneDir } = await withLane();
    expect((await runBrief({ lane: 'lane_1', container }, deps)).lane).toBe('lane_1');
    expect((await runBrief({}, { ...deps, cwd: () => join(laneDir, '.ai') })).lane).toBe('lane_1');
    await expect(runBrief({ lane: 'nope', container }, deps)).rejects.toBeInstanceOf(InvalidInputError);
    const closed = await withLane({ state: 'closed', closed: '2026-09-29T13:00:00.000Z' });
    await expect(runBrief({ lane: 'lane_1', container: closed.container }, closed.deps)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('prints the text with --format table', async () => {
    const { deps, container } = await withLane();
    const r = await runCli(['brief', 'lane_1', '--container', container, '--format', 'table'], deps);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('# Lane brief: lane_1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/brief.test.js`
Expected: FAIL — cannot resolve `../src/lib/brief.js`.

- [ ] **Step 3: Implement**

`src/lib/brief.js`:
```js
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { laneBlock } from './board.js';
import { laneId } from './ids.js';

// Spec §7.4: a subagent inherits the parent's cwd and instructions, not the lane's, so the brief
// carries everything it needs to work in the lane.
export function buildBrief(ctx, name, lane) {
  const laneDir = join(ctx.root, lane.repos[0].path);
  const envFile = join(laneDir, '.laines.env');
  const [start, end] = lane.ports;
  const candidates = [
    [join(laneDir, 'CLAUDE.md'), "the repository's instructions"],
    [join(laneDir, 'AGENTS.md'), 'agent instructions'],
    [join(laneDir, 'GEMINI.md'), 'agent instructions'],
    [join(laneDir, 'CLAUDE.local.md'), "this lane's identity and rules"],
    [join(laneDir, '.ai', 'README.md'), 'lane rules'],
    [join(ctx.paths.ai, 'knowledge'), 'shared knowledge'],
    [join(ctx.paths.ai, 'guidelines'), 'shared guidelines'],
    [join(ctx.paths.ai, 'lessons'), 'shared lessons'],
    [join(laneDir, '.ai', 'context'), 'handoff notes from earlier sessions'],
    [join(laneDir, '.ai', 'plans'), 'plans for the current task'],
  ];
  const readFirst = candidates.filter(([p]) => existsSync(p)).map(([path, why]) => ({ path, why }));
  const rules = [
    `Work only inside ${laneDir}: use \`git -C ${laneDir}\` or cd into it. Never edit other lanes or the container's .laines/.`,
    `Source ${envFile} before starting services, and use only ports ${start}–${end}.`,
    `Report status with \`laines report ${name} --status "..." --task "..."\` (run it inside the lane, or add --container ${ctx.root}).`,
    `Write durable knowledge, guidelines, lessons, data and audits to ${ctx.paths.ai}/, not into the lane.`,
    'Never run `dot-ai init` or `dot-ai sync` in the lane.',
    'Teardown, release, hook approval, hook policy and config changes are for a human.',
  ];
  const board = laneBlock(name, lane);
  const id = laneId(ctx.id, name);
  const text = [
    `# Lane brief: ${name} (${id})`,
    '',
    `- Path: ${laneDir}`,
    `- Branch: ${lane.repos[0].branch}`,
    `- Ports: ${start}–${end}`,
    `- Environment: ${envFile}`,
    '',
    '## Read first',
    '',
    ...readFirst.map((r) => `- ${r.path} (${r.why})`),
    '',
    '## Rules',
    '',
    ...rules.map((r) => `- ${r}`),
    '',
    '## Board entry',
    '',
    board,
    '',
  ].join('\n');
  return { lane: name, id, path: laneDir, branch: lane.repos[0].branch, ports: lane.ports, envFile, readFirst, rules, board, text };
}
```

`src/commands/brief.js`:
```js
import { laneFrom, loadContainer } from '../lib/container.js';
import { readLanes } from '../lib/lanes-store.js';
import { buildBrief } from '../lib/brief.js';
import { InvalidInputError } from '../lib/errors.js';

export async function runBrief(opts, deps) {
  const ctx = loadContainer(opts, deps);
  const name = laneFrom(opts, deps);
  const lane = readLanes(ctx).lanes[name];
  if (!lane) throw new InvalidInputError(`No lane named ${name}. See \`laines list\`.`);
  if (lane.state === 'closed') throw new InvalidInputError(`Lane ${name} is closed.`);
  return buildBrief(ctx, name, lane);
}
```

`src/lib/format.js` — append:
```js
export const formatBrief = (r) => r.text;
```

`src/cli.js` — import `runBrief` and `formatBrief`, and register after `doctor`:
```js
  withGlobals(program.command('brief'))
    .description('Print the handoff for an agent working in a lane')
    .argument('[lane]', 'lane name (default: the lane you are in)')
    .action(handle(runBrief, { table: formatBrief, args: ['lane'] }, deps));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/brief.test.js` then `npm run test:run && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/brief.js src/commands/brief.js src/lib/format.js src/cli.js test/brief.test.js
git commit -m "feat: laines brief" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `create`

**Files:**
- Create: `src/commands/create.js`
- Modify: `src/lib/format.js` (add `formatCreate`), `src/cli.js` (register `create`)
- Test: `test/create.test.js`

**Interfaces:**
- Consumes: `loadContainer` (Task 2), `readLanes`/`updateLanes` (Task 3), `assertLaneDir`/`removeLaneDir`/`writeLaneFiles` (Task 4), `buildBrief` (Task 5), `gitOut` (Task 1), `lanePorts`/`laneId` (M1), `appendAudit` (M1), `GitError`/`BlockedError`/`InvalidInputError`.
- Produces:
  - `runCreate({ name?, branch?, dryRun?, container? }, deps) → CreateResult` where `CreateResult = { dryRun, lane, id, number, path, branch, ports, remote?, files?, warnings, brief?, next? }`
  - Lane number = smallest N ≥ 1 not used by a non-closed lane; `N > maxLanes` → `BlockedError`. Default name `<lanePrefix><N>`.
  - Reservation first (status `spinning up`), then the port probe, clone and checkout outside the lock; any failure removes the partial clone (through `removeLaneDir`) and the reservation.
  - `formatCreate(r) → string`; CLI `laines create [name] [--branch <b>] [--dry-run]`

- [ ] **Step 1: Write the failing test**

`test/create.test.js`:
```js
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCreate } from '../src/commands/create.js';
import { loadContainer } from '../src/lib/container.js';
import { readLanes } from '../src/lib/lanes-store.js';
import { BlockedError, GitError, InvalidInputError } from '../src/lib/errors.js';
import { cleanupTmp, setupContainer, gitIn, runCli } from './helpers.js';

afterEach(cleanupTmp);

describe('create', () => {
  it('clones an isolated lane, writes its files and registers it on the board', async () => {
    const { deps, container } = await setupContainer();
    const r = await runCreate({ container }, deps);
    const laneDir = join(container, 'lane_1');
    expect(r).toMatchObject({ dryRun: false, lane: 'lane_1', id: 'my-app/lane_1', number: 1, path: laneDir, branch: 'main', ports: [20000, 20009], warnings: [] });
    expect(gitIn(laneDir, 'branch', '--show-current').trim()).toBe('main');
    expect(gitIn(laneDir, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(laneDir, '.laines.env'), 'utf8')).toContain('LANE_SUFFIX="_my_app_l1"');
    const ctx = loadContainer({ container }, deps);
    expect(readLanes(ctx).lanes.lane_1).toMatchObject({ state: 'active', status: 'idle', ports: [20000, 20009] });
    expect(readFileSync(ctx.paths.board, 'utf8')).toContain('<!-- lane:lane_1:start -->');
    expect(readFileSync(ctx.paths.audit, 'utf8')).toContain('"action":"create"');
    expect(r.brief.text).toContain('# Lane brief: lane_1');
    expect(r.next[0]).toBe(`cd ${laneDir} && claude`);
  });

  it('gives each lane its own number and ports, tracks remote branches, and creates new ones', async () => {
    const { deps, container } = await setupContainer({ branches: ['feature'] });
    await runCreate({ container }, deps);
    const two = await runCreate({ container, branch: 'feature' }, deps);
    expect(two).toMatchObject({ lane: 'lane_2', ports: [20010, 20019] });
    expect(gitIn(two.path, 'rev-parse', '--abbrev-ref', '@{u}').trim()).toBe('origin/feature');
    const named = await runCreate({ container, name: 'spike', branch: 'try/new' }, deps);
    expect(named).toMatchObject({ lane: 'spike', number: 3, ports: [20020, 20029] });
    expect(gitIn(named.path, 'branch', '--show-current').trim()).toBe('try/new');
  });

  it('dry run plans without cloning or reserving', async () => {
    const { deps, container } = await setupContainer();
    const r = await runCreate({ container, dryRun: true }, deps);
    expect(r).toMatchObject({ dryRun: true, lane: 'lane_1', ports: [20000, 20009] });
    expect(existsSync(join(container, 'lane_1'))).toBe(false);
    expect(readLanes(loadContainer({ container }, deps)).lanes).toEqual({});
  });

  it('refuses bad names and branches before touching anything', async () => {
    const { deps, container } = await setupContainer();
    mkdirSync(join(container, 'taken'));
    for (const opts of [{ name: 'Bad Name' }, { name: '.ai' }, { branch: '-x' }, { branch: 'bad..ref' }, { name: 'taken' }]) {
      await expect(runCreate({ container, ...opts }, deps), JSON.stringify(opts)).rejects.toBeInstanceOf(InvalidInputError);
    }
    expect(readLanes(loadContainer({ container }, deps)).lanes).toEqual({});
  });

  it('rolls back when ports are busy or the clone fails', async () => {
    const s = await setupContainer();
    const busy = { ...s.deps, busyPorts: async ([a]) => [a] };
    await expect(runCreate({ container: s.container }, busy)).rejects.toThrow(/Ports already in use: 20000/);
    const failingGit = { ...s.deps, git: (args, o) => (args[0] === 'clone' ? { status: 128, stdout: '', stderr: 'fatal: repository not found' } : s.deps.git(args, o)) };
    await expect(runCreate({ container: s.container }, failingGit)).rejects.toBeInstanceOf(GitError);
    const ctx = loadContainer({ container: s.container }, s.deps);
    expect(readLanes(ctx).lanes).toEqual({});
    expect(existsSync(join(s.container, 'lane_1'))).toBe(false);
    expect(readFileSync(ctx.paths.board, 'utf8')).toContain('lane creation failed');
  });

  it('stops at maxLanes and reuses the number of a closed lane', async () => {
    const { deps, container } = await setupContainer();
    const cfgFile = join(container, '.laines', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
    writeFileSync(cfgFile, JSON.stringify({ ...cfg, maxLanes: 1 }));
    await runCreate({ container }, deps);
    await expect(runCreate({ container }, deps)).rejects.toBeInstanceOf(BlockedError);
    const lanesFile = join(container, '.laines', 'lanes.json');
    const state = JSON.parse(readFileSync(lanesFile, 'utf8'));
    state.lanes.lane_1.state = 'closed';
    writeFileSync(lanesFile, JSON.stringify(state));
    await expect(runCreate({ container }, deps)).rejects.toThrow(/already exists/);
    const r = await runCreate({ container, name: 'fresh' }, deps);
    expect(r).toMatchObject({ lane: 'fresh', number: 1, ports: [20000, 20009] });
  });

  it('works in a container whose path has spaces, and two creates at once get different lanes', async () => {
    const { deps, container } = await setupContainer({ dir: 'my lanes' });
    const [a, b] = await Promise.all([runCreate({ container }, deps), runCreate({ container }, deps)]);
    expect(new Set([a.lane, b.lane])).toEqual(new Set(['lane_1', 'lane_2']));
    expect(gitIn(a.path, 'status', '--porcelain')).toBe('');
  });

  it('prints a table with the brief', async () => {
    const { deps, container } = await setupContainer();
    const r = await runCli(['create', '--container', container, '--format', 'table'], deps);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('lane lane_1 created');
    expect(r.stdout).toContain('# Lane brief: lane_1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/create.test.js`
Expected: FAIL — cannot resolve `../src/commands/create.js`.

- [ ] **Step 3: Implement**

`src/commands/create.js`:
```js
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadContainer } from '../lib/container.js';
import { readLanes, updateLanes } from '../lib/lanes-store.js';
import { assertLaneDir, removeLaneDir } from '../lib/containment.js';
import { writeLaneFiles } from '../lib/lane-files.js';
import { buildBrief } from '../lib/brief.js';
import { gitOut } from '../lib/git.js';
import { lanePorts } from '../lib/ports.js';
import { laneId } from '../lib/ids.js';
import { appendAudit } from '../lib/audit.js';
import { BlockedError, InvalidInputError } from '../lib/errors.js';

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function planLane(ctx, state, opts) {
  const used = new Set(Object.values(state.lanes).filter((l) => l.state !== 'closed').map((l) => l.number));
  let number = 1;
  while (used.has(number)) number += 1;
  if (number > ctx.config.maxLanes) {
    throw new BlockedError(`All ${ctx.config.maxLanes} lanes are in use. Tear one down, or raise maxLanes in .laines/config.json.`);
  }
  const name = opts.name ?? `${ctx.config.lanePrefix}${number}`;
  const existing = state.lanes[name];
  if (existing && existing.state !== 'closed') throw new InvalidInputError(`Lane ${name} already exists.`);
  const laneDir = join(ctx.root, name);
  assertLaneDir(ctx.root, laneDir, name);
  if (existsSync(laneDir)) throw new InvalidInputError(`${laneDir} already exists. Remove it or pick another name.`);
  return { name, number, laneDir, ports: lanePorts(ctx.portRange, number, ctx.config.ports.stride) };
}

function validate(ctx, deps, opts, branch) {
  if (opts.name !== undefined && !NAME.test(opts.name)) {
    throw new InvalidInputError(`Invalid lane name "${opts.name}": use lowercase letters, digits, "_" and "-", start with a letter or digit, max 32 characters.`);
  }
  if (String(branch).startsWith('-') || deps.git(['check-ref-format', '--branch', branch], { cwd: ctx.root }).status !== 0) {
    throw new InvalidInputError(`Invalid branch name "${branch}".`);
  }
}

export async function runCreate(opts, deps) {
  const ctx = loadContainer(opts, deps);
  const [repoName, repo] = Object.entries(ctx.config.repos)[0];
  const branch = opts.branch ?? repo.defaultBranch;
  validate(ctx, deps, opts, branch);

  if (opts.dryRun) {
    const p = planLane(ctx, readLanes(ctx), opts);
    return { dryRun: true, lane: p.name, id: laneId(ctx.id, p.name), number: p.number, path: p.laneDir, branch, ports: p.ports, remote: repo.remote, warnings: [] };
  }

  // Reserve under the lock so concurrent creates never pick the same number; clone outside it.
  const now = deps.now();
  const plan = await updateLanes(ctx, deps, (state) => {
    const p = planLane(ctx, state, opts);
    state.lanes[p.name] = {
      number: p.number,
      repos: [{ name: repoName, path: p.name, branch }],
      ports: p.ports,
      state: 'active',
      status: 'spinning up',
      task: null,
      blocked: null,
      kept: null,
      created: now,
      updated: now,
      closed: null,
    };
    return { state, result: p, activity: [{ ts: now, lane: p.name, text: `lane reserved (ports ${p.ports[0]}–${p.ports[1]}); cloning ${branch}` }] };
  });

  const abandon = async (why) => {
    removeLaneDir(ctx.root, plan.laneDir, plan.name);
    await updateLanes(ctx, deps, (state) => {
      delete state.lanes[plan.name];
      return { state, result: null, activity: [{ ts: deps.now(), lane: plan.name, text: `lane creation failed: ${why}` }] };
    });
  };

  const busy = await deps.busyPorts(plan.ports);
  if (busy.length) {
    await abandon('ports in use');
    throw new InvalidInputError(`Ports already in use: ${busy.join(', ')}. Stop what is using them (check with \`lsof -i :${busy[0]}\`) and retry.`);
  }

  let files;
  try {
    gitOut(deps, ['clone', '--', repo.remote, plan.laneDir], ctx.root);
    const current = gitOut(deps, ['branch', '--show-current'], plan.laneDir).trim();
    if (current !== branch) {
      const onRemote = deps.git(['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd: plan.laneDir }).status === 0;
      gitOut(deps, onRemote ? ['checkout', '-q', '-b', branch, '--track', `origin/${branch}`] : ['checkout', '-q', '-b', branch], plan.laneDir);
    }
    files = writeLaneFiles(ctx, deps, { ...plan, branch });
  } catch (err) {
    await abandon(String(err.message).split('\n')[0]);
    throw err;
  }
  // M3: run the post-create hook here.

  const lane = await updateLanes(ctx, deps, (state) => {
    const l = state.lanes[plan.name];
    l.status = 'idle';
    l.updated = deps.now();
    return { state, result: l, activity: [{ ts: deps.now(), lane: plan.name, text: `lane created on branch ${branch}` }] };
  });
  appendAudit(ctx.paths.audit, { ts: deps.now(), action: 'create', container: ctx.id, lane: plan.name, branch }, { warn: deps.warn });

  return {
    dryRun: false,
    lane: plan.name,
    id: laneId(ctx.id, plan.name),
    number: plan.number,
    path: plan.laneDir,
    branch,
    ports: plan.ports,
    files: files.written,
    warnings: files.skipped.map((s) => `${s.file} not written: ${s.reason}`),
    brief: buildBrief(ctx, plan.name, lane),
    next: [`cd ${plan.laneDir} && ${ctx.config.agentCmd}`, `or hand \`laines brief ${plan.name}\` to a subagent`],
  };
}
```

`src/lib/format.js` — append:
```js
export function formatCreate(r) {
  const head = [
    r.dryRun ? `dry run: would create ${r.lane} (${r.id})` : `lane ${r.lane} created`,
    `path:    ${r.path}`,
    `branch:  ${r.branch}`,
    `ports:   ${r.ports[0]}–${r.ports[1]}`,
  ];
  if (r.dryRun) return [...head, `remote:  ${r.remote}`].join('\n');
  const lines = [...head, ...r.warnings.map((w) => `warning: ${w}`), '', r.brief.text, 'next:', ...r.next.map((s) => `  ${s}`)];
  return lines.join('\n');
}
```

`src/cli.js` — import `runCreate` and `formatCreate`, and register after `doctor`:
```js
  withGlobals(program.command('create'))
    .description('Create a lane: an isolated clone with its own ports, env file and lane files')
    .argument('[name]', 'lane name (default: the next free <lanePrefix><N>)')
    .option('--branch <name>', 'branch to check out (default: the container default branch)')
    .option('--dry-run', 'show what would be created without cloning or reserving anything')
    .action(handle(runCreate, { table: formatCreate, args: ['name'] }, deps));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/create.test.js` then `npm run test:run && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/create.js src/lib/format.js src/cli.js test/create.test.js
git commit -m "feat: laines create" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `report`, `keep`, `release`, `list`, `status`

**Files:**
- Create: `src/commands/lanes.js`
- Modify: `src/lib/format.js`, `src/cli.js`
- Test: `test/lanes.test.js`

**Interfaces:**
- Consumes: `loadContainer`, `laneFrom`, `detectLane` (Task 2), `readLanes`/`updateLanes` (Task 3), `laneId`, `appendAudit`, `InvalidInputError`.
- Produces:
  - `runReport({ lane?, status?, task?, blocked?, note?, container? }, deps) → { lane, status, task, blocked, updated }` — `-` clears `task`/`blocked`; `--note` only adds an Activity Log line; text fields must be non-empty and ≤ 500 characters.
  - `runKeep({ lane?, reason, container? }, deps) → { lane, kept: { reason, since } }`
  - `runRelease({ lane, container? }, deps) → { lane, released: boolean }` (name required)
  - `runList({ all?, container? }, deps) → { container: { id, path, portRange }, lanes: LaneSummary[] }` where `LaneSummary = { lane, number, state, status, task, branch, ports, kept, path, updated }` (closed lanes only with `all`)
  - `runStatus({ lane?, container? }, deps)` → overview `{ container, lanes, requests }` when no lane is named and the cwd is not a lane; otherwise `{ lane, id, path, envFile, state, status, task, blocked, branch, ports, kept, created, updated }`
  - `formatReport`, `formatKeep`, `formatRelease`, `formatList`, `formatStatus`
  - CLI: `report [lane] --status --task --blocked --note`, `keep [lane] --reason`, `release <lane>`, `list [--all]`, `status [lane]`

- [ ] **Step 1: Write the failing test**

`test/lanes.test.js`:
```js
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCreate } from '../src/commands/create.js';
import { runReport, runKeep, runRelease, runList, runStatus } from '../src/commands/lanes.js';
import { loadContainer } from '../src/lib/container.js';
import { readLanes } from '../src/lib/lanes-store.js';
import { InvalidInputError } from '../src/lib/errors.js';
import { cleanupTmp, setupContainer, runCli } from './helpers.js';

afterEach(cleanupTmp);

async function oneLane() {
  const s = await setupContainer();
  const lane = await runCreate({ container: s.container }, s.deps);
  return { ...s, lane };
}

describe('report', () => {
  it('updates fields, clears with "-", and logs notes', async () => {
    const { deps, container, lane } = await oneLane();
    const r = await runReport({ lane: 'lane_1', status: 'in-progress', task: 'webhooks', blocked: 'staging creds', container }, deps);
    expect(r).toMatchObject({ lane: 'lane_1', status: 'in-progress', task: 'webhooks', blocked: 'staging creds' });
    const cleared = await runReport({ blocked: '-', container }, { ...deps, cwd: () => lane.path });
    expect(cleared.blocked).toBeNull();
    await runReport({ lane: 'lane_1', note: 'opened PR #12', container }, deps);
    const ctx = loadContainer({ container }, deps);
    expect(readLanes(ctx).activity[0].text).toBe('opened PR #12');
    expect(readFileSync(ctx.paths.board, 'utf8')).toContain('- **Task:** webhooks');
  });

  it('refuses nothing-to-report, empty or oversized text, and unknown lanes', async () => {
    const { deps, container } = await oneLane();
    const bad = [
      { lane: 'lane_1' },
      { lane: 'lane_1', status: '   ' },
      { lane: 'lane_1', task: 'x'.repeat(501) },
      { lane: 'nope', status: 'x' },
    ];
    for (const opts of bad) {
      await expect(runReport({ ...opts, container }, deps), JSON.stringify(opts).slice(0, 60)).rejects.toBeInstanceOf(InvalidInputError);
    }
  });
});

describe('keep and release', () => {
  it('pins a lane with a reason and releases it idempotently', async () => {
    const { deps, container } = await oneLane();
    await expect(runKeep({ lane: 'lane_1', container }, deps)).rejects.toBeInstanceOf(InvalidInputError);
    const k = await runKeep({ lane: 'lane_1', reason: 'base of stacked PR #12', container }, deps);
    expect(k.kept).toEqual({ reason: 'base of stacked PR #12', since: '2026-09-29T12:00:00.000Z' });
    const ctx = loadContainer({ container }, deps);
    expect(readFileSync(ctx.paths.board, 'utf8')).toContain('### lane_1 📌');
    expect(await runRelease({ lane: 'lane_1', container }, deps)).toEqual({ lane: 'lane_1', released: true });
    expect(await runRelease({ lane: 'lane_1', container }, deps)).toEqual({ lane: 'lane_1', released: false });
    await expect(runRelease({ container }, deps)).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe('list and status', () => {
  it('summarises lanes and shows one lane in detail', async () => {
    const { deps, container, lane } = await oneLane();
    const l = await runList({ container }, deps);
    expect(l.container).toEqual({ id: 'my-app', path: container, portRange: [20000, 20199] });
    expect(l.lanes).toEqual([expect.objectContaining({ lane: 'lane_1', number: 1, state: 'active', status: 'idle', branch: 'main', ports: [20000, 20009], kept: null, path: lane.path })]);
    const overview = await runStatus({ container }, deps);
    expect(overview.lanes).toHaveLength(1);
    expect(overview.requests).toEqual([]);
    const one = await runStatus({}, { ...deps, cwd: () => lane.path });
    expect(one).toMatchObject({ lane: 'lane_1', id: 'my-app/lane_1', envFile: join(lane.path, '.laines.env'), state: 'active' });
  });

  it('hides closed lanes unless --all', async () => {
    const { deps, container } = await oneLane();
    const file = join(container, '.laines', 'lanes.json');
    const state = JSON.parse(readFileSync(file, 'utf8'));
    state.lanes.lane_1.state = 'closed';
    (await import('node:fs')).writeFileSync(file, JSON.stringify(state));
    expect((await runList({ container }, deps)).lanes).toEqual([]);
    expect((await runList({ container, all: true }, deps)).lanes).toHaveLength(1);
  });

  it('wires the commands into the CLI', async () => {
    const { deps, container } = await oneLane();
    const report = await runCli(['report', 'lane_1', '--status', 'review', '--container', container, '--format', 'table'], deps);
    expect(report.code).toBe(0);
    expect(report.stdout).toContain('lane_1: status=review');
    const list = await runCli(['list', '--container', container, '--format', 'table'], deps);
    expect(list.stdout).toContain('lane_1');
    const keep = await runCli(['keep', 'lane_1', '--reason', 'stack', '--container', container], deps);
    expect(keep.code).toBe(0);
    const release = await runCli(['release', 'lane_1', '--container', container], deps);
    expect(JSON.parse(release.stdout).released).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lanes.test.js`
Expected: FAIL — cannot resolve `../src/commands/lanes.js`.

- [ ] **Step 3: Implement**

`src/commands/lanes.js`:
```js
import { join } from 'node:path';
import { detectLane, laneFrom, loadContainer } from '../lib/container.js';
import { readLanes, updateLanes } from '../lib/lanes-store.js';
import { laneId } from '../lib/ids.js';
import { appendAudit } from '../lib/audit.js';
import { InvalidInputError } from '../lib/errors.js';

const MAX_TEXT = 500;

function text(value, label) {
  const s = String(value).trim();
  if (!s) throw new InvalidInputError(`${label} must not be empty.`);
  if (s.length > MAX_TEXT) throw new InvalidInputError(`${label} is longer than ${MAX_TEXT} characters.`);
  return s;
}

function openLane(state, name) {
  const lane = state.lanes[name];
  if (!lane) throw new InvalidInputError(`No lane named ${name}. See \`laines list\`.`);
  if (lane.state === 'closed') throw new InvalidInputError(`Lane ${name} is closed.`);
  return lane;
}

const summary = (ctx, name, l) => ({
  lane: name,
  number: l.number,
  state: l.state,
  status: l.status,
  task: l.task,
  branch: l.repos[0].branch,
  ports: l.ports,
  kept: l.kept,
  path: join(ctx.root, l.repos[0].path),
  updated: l.updated,
});

export async function runReport(opts, deps) {
  const ctx = loadContainer(opts, deps);
  const name = laneFrom(opts, deps);
  const changes = ['status', 'task', 'blocked'].filter((k) => opts[k] !== undefined);
  if (!changes.length && opts.note === undefined) {
    throw new InvalidInputError('Nothing to report: pass --status, --task, --blocked or --note.');
  }
  const status = opts.status !== undefined ? text(opts.status, '--status') : undefined;
  const task = opts.task === undefined ? undefined : opts.task === '-' ? null : text(opts.task, '--task');
  const blocked = opts.blocked === undefined ? undefined : opts.blocked === '-' ? null : text(opts.blocked, '--blocked');
  const note = opts.note !== undefined ? text(opts.note, '--note') : null;
  const now = deps.now();
  return updateLanes(ctx, deps, (state) => {
    const l = openLane(state, name);
    if (status !== undefined) l.status = status;
    if (task !== undefined) l.task = task;
    if (blocked !== undefined) l.blocked = blocked;
    if (changes.length) l.updated = now;
    const line = note ?? `status=${l.status}, task=${l.task ?? '-'}${l.blocked ? `, blocked on ${l.blocked}` : ''}`;
    return {
      state,
      result: { lane: name, status: l.status, task: l.task, blocked: l.blocked, updated: l.updated },
      activity: [{ ts: now, lane: name, text: line }],
    };
  });
}

export async function runKeep(opts, deps) {
  const ctx = loadContainer(opts, deps);
  const name = laneFrom(opts, deps);
  if (opts.reason === undefined) throw new InvalidInputError('--reason is required: say what depends on this lane.');
  const reason = text(opts.reason, '--reason');
  const now = deps.now();
  const r = await updateLanes(ctx, deps, (state) => {
    const l = openLane(state, name);
    l.kept = { reason, since: l.kept?.since ?? now };
    l.updated = now;
    return { state, result: { lane: name, kept: l.kept }, activity: [{ ts: now, lane: name, text: `kept: ${reason}` }] };
  });
  appendAudit(ctx.paths.audit, { ts: now, action: 'keep', container: ctx.id, lane: name }, { warn: deps.warn });
  return r;
}

// Human-only (deny rules in agent settings); the lane must always be named.
export async function runRelease(opts, deps) {
  if (!opts.lane) throw new InvalidInputError('Name the lane to release: `laines release <lane>`.');
  const ctx = loadContainer(opts, deps);
  const name = opts.lane;
  const now = deps.now();
  const r = await updateLanes(ctx, deps, (state) => {
    const l = openLane(state, name);
    if (!l.kept) return { state, result: { lane: name, released: false } };
    l.kept = null;
    l.updated = now;
    return { state, result: { lane: name, released: true }, activity: [{ ts: now, lane: name, text: 'released (no longer kept)' }] };
  });
  if (r.released) appendAudit(ctx.paths.audit, { ts: now, action: 'release', container: ctx.id, lane: name }, { warn: deps.warn });
  return r;
}

export async function runList(opts, deps) {
  const ctx = loadContainer(opts, deps);
  const lanes = Object.entries(readLanes(ctx).lanes)
    .filter(([, l]) => opts.all || l.state !== 'closed')
    .sort(([, a], [, b]) => a.number - b.number)
    .map(([name, l]) => summary(ctx, name, l));
  return { container: { id: ctx.id, path: ctx.root, portRange: ctx.portRange }, lanes };
}

export async function runStatus(opts, deps) {
  const ctx = loadContainer(opts, deps);
  const state = readLanes(ctx);
  const name = opts.lane ?? detectLane(deps.cwd())?.lane;
  if (!name) {
    const lanes = Object.entries(state.lanes)
      .filter(([, l]) => l.state !== 'closed')
      .sort(([, a], [, b]) => a.number - b.number)
      .map(([n, l]) => summary(ctx, n, l));
    return { container: { id: ctx.id, path: ctx.root, portRange: ctx.portRange }, lanes, requests: state.requests };
  }
  const l = state.lanes[name];
  if (!l) throw new InvalidInputError(`No lane named ${name}. See \`laines list\`.`);
  const path = join(ctx.root, l.repos[0].path);
  return {
    lane: name,
    id: laneId(ctx.id, name),
    path,
    envFile: join(path, '.laines.env'),
    state: l.state,
    status: l.status,
    task: l.task,
    blocked: l.blocked,
    branch: l.repos[0].branch,
    ports: l.ports,
    kept: l.kept,
    created: l.created,
    updated: l.updated,
  };
}
```

`src/lib/format.js` — append:
```js
export const formatReport = (r) => `${r.lane}: status=${r.status}, task=${r.task ?? '-'}, blocked=${r.blocked ?? '-'}`;
export const formatKeep = (r) => `${r.lane} kept: ${r.kept.reason}`;
export const formatRelease = (r) => (r.released ? `${r.lane} released` : `${r.lane} was not kept`);

export function formatList(r) {
  if (!r.lanes.length) return 'no lanes';
  return r.lanes
    .map((l) => [
      l.kept ? '📌' : '  ',
      l.lane.padEnd(14),
      l.state.padEnd(13),
      String(l.status).padEnd(14),
      l.branch.padEnd(28),
      `${l.ports[0]}–${l.ports[1]}`,
    ].join(' '))
    .join('\n');
}

export function formatStatus(r) {
  if (r.lanes) {
    const requests = r.requests.length ? r.requests.map((q) => `  ${q.text} → ${q.command}`).join('\n') : '  none';
    return [`container ${r.container.id} · ports ${r.container.portRange[0]}–${r.container.portRange[1]}`, formatList(r), 'requests:', requests].join('\n');
  }
  return [
    `${r.lane} (${r.id})`,
    `state:   ${r.state}`,
    `status:  ${r.status}`,
    `task:    ${r.task ?? '-'}`,
    `blocked: ${r.blocked ?? '-'}`,
    `branch:  ${r.branch}`,
    `ports:   ${r.ports[0]}–${r.ports[1]}`,
    `path:    ${r.path}`,
    `kept:    ${r.kept ? r.kept.reason : '-'}`,
  ].join('\n');
}
```

`src/cli.js` — import the five `run*` functions and five formatters, and register after `create`:
```js
  withGlobals(program.command('report'))
    .description("Update a lane's board entry")
    .argument('[lane]', 'lane name (default: the lane you are in)')
    .option('--status <text>', 'lane status, e.g. idle, in-progress, review')
    .option('--task <text>', 'current task ("-" clears it)')
    .option('--blocked <text>', 'what the lane is blocked on ("-" clears it)')
    .option('--note <text>', 'a line for the Activity Log')
    .action(handle(runReport, { table: formatReport, args: ['lane'] }, deps));

  withGlobals(program.command('keep'))
    .description('Pin a lane so it cannot be torn down until a human releases it')
    .argument('[lane]', 'lane name (default: the lane you are in)')
    .option('--reason <text>', 'what depends on this lane, e.g. "base of stacked PR #123"')
    .action(handle(runKeep, { table: formatKeep, args: ['lane'] }, deps));

  withGlobals(program.command('release'))
    .description('Unpin a kept lane (human-only)')
    .argument('<lane>', 'lane name')
    .action(handle(runRelease, { table: formatRelease, args: ['lane'] }, deps));

  withGlobals(program.command('list'))
    .description('List lanes')
    .option('--all', 'include closed lanes')
    .action(handle(runList, { table: formatList }, deps));

  withGlobals(program.command('status'))
    .description('Show the container overview, or one lane')
    .argument('[lane]', 'lane name (default: the lane you are in, else the overview)')
    .action(handle(runStatus, { table: formatStatus, args: ['lane'] }, deps));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lanes.test.js` then `npm run test:run && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/lanes.js src/lib/format.js src/cli.js test/lanes.test.js
git commit -m "feat: report, keep, release, list and status" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `teardown`

**Files:**
- Create: `src/lib/lane-git.js`, `src/commands/teardown.js`
- Modify: `src/lib/format.js` (add `formatTeardown`), `src/cli.js` (register `teardown`)
- Test: `test/teardown.test.js`

**Interfaces:**
- Consumes: `loadContainer` (Task 2), `readLanes`/`updateLanes` (Task 3), `assertLaneDir`/`removeLaneDir`/`untrackedEntries` (Task 4), `gitOut` (Task 1), `appendAudit`, `BlockedError`/`InvalidInputError`.
- Produces:
  - `unpushedWork(deps, laneDir) → { dirty: string[], stashes: number, unpushed: number, refs: [{ ref, commits }], noUpstream: string|null, problems: string[] }` — commit-level and ref-agnostic (`git rev-list --count --exclude=refs/stash --all --not --remotes`), stash counted separately, lane-local files already hidden by the exclude block.
  - `runTeardown({ lane, removeDir?, force?, dryRun?, container? }, deps) → { dryRun, lane, path, blocked?, archivedTo, contextDeleted, removedDir, forced, checks, warnings }`
  - Order (spec §10.3): kept → refuse (every path, even `--force`); with `--remove-dir`, run `unpushedWork` and refuse unless `--force` (nothing touched); `// M3: pre-teardown`; move the lane's untracked `.ai/plans/` entries to `<container>/.ai/archive/<date>_<lane>/plans/`; delete untracked `.ai/context/` entries; mark closed (requests for the lane dropped); with `--remove-dir`, `removeLaneDir`; `// M3: post-teardown`; audit.
  - `formatTeardown(r) → string`; CLI `laines teardown <lane> [--remove-dir] [--force] [--dry-run]`

- [ ] **Step 1: Write the failing test**

`test/teardown.test.js`:
```js
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCreate } from '../src/commands/create.js';
import { runKeep } from '../src/commands/lanes.js';
import { runTeardown } from '../src/commands/teardown.js';
import { loadContainer } from '../src/lib/container.js';
import { readLanes } from '../src/lib/lanes-store.js';
import { BlockedError, InvalidInputError } from '../src/lib/errors.js';
import { tmp, cleanupTmp, setupContainer, gitIn, runCli } from './helpers.js';

afterEach(cleanupTmp);

async function lane(opts = {}) {
  const s = await setupContainer(opts);
  const l = await runCreate({ container: s.container }, s.deps);
  return { ...s, dir: l.path };
}

const state = (s) => readLanes(loadContainer({ container: s.container }, s.deps)).lanes.lane_1;

describe('teardown without --remove-dir', () => {
  it('archives plans, deletes context, marks closed and leaves the clone', async () => {
    const s = await lane();
    writeFileSync(join(s.dir, '.ai', 'plans', 'task.md'), 'plan\n');
    writeFileSync(join(s.dir, '.ai', 'context', 'handoff.md'), 'notes\n');
    const r = await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    expect(r).toMatchObject({ dryRun: false, lane: 'lane_1', archivedTo: '.ai/archive/2026-09-29_lane_1', contextDeleted: true, removedDir: false });
    expect(readFileSync(join(s.container, '.ai', 'archive', '2026-09-29_lane_1', 'plans', 'task.md'), 'utf8')).toBe('plan\n');
    expect(existsSync(join(s.dir, '.ai', 'context', 'handoff.md'))).toBe(false);
    expect(existsSync(s.dir)).toBe(true);
    expect(state(s)).toMatchObject({ state: 'closed', status: 'closed', closed: '2026-09-29T12:00:00.000Z' });
    expect(readFileSync(join(s.container, '.ai', 'context', 'LANES_BOARD.md'), 'utf8')).toContain('1 closed lane');
    await expect(runTeardown({ lane: 'lane_1', container: s.container }, s.deps)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('never archives or deletes files the repository tracks', async () => {
    const s = await lane({ files: { 'README.md': 'x\n', '.ai/plans/README.md': 'project plans\n', '.ai/context/README.md': 'project context\n' } });
    writeFileSync(join(s.dir, '.ai', 'plans', 'mine.md'), 'm\n');
    await runTeardown({ lane: 'lane_1', container: s.container }, s.deps);
    expect(readFileSync(join(s.dir, '.ai', 'plans', 'README.md'), 'utf8')).toBe('project plans\n');
    expect(readFileSync(join(s.dir, '.ai', 'context', 'README.md'), 'utf8')).toBe('project context\n');
    expect(existsSync(join(s.dir, '.ai', 'plans', 'mine.md'))).toBe(false);
    expect(gitIn(s.dir, 'status', '--porcelain')).toBe('');
  });
});

describe('teardown --remove-dir safety', () => {
  it('removes a clean lane', async () => {
    const s = await lane();
    const r = await runTeardown({ lane: 'lane_1', removeDir: true, container: s.container }, s.deps);
    expect(r.removedDir).toBe(true);
    expect(existsSync(s.dir)).toBe(false);
  });

  const unsafe = {
    'uncommitted changes': (dir) => writeFileSync(join(dir, 'new.txt'), 'x\n'),
    'a stash entry': (dir) => {
      writeFileSync(join(dir, 'README.md'), 'changed\n');
      gitIn(dir, 'stash', '-q');
    },
    'an unpushed branch with no upstream': (dir) => {
      gitIn(dir, 'checkout', '-q', '-b', 'local-only');
      gitIn(dir, 'commit', '-q', '--allow-empty', '-m', 'local');
    },
    'a commit only in refs/backup': (dir) => {
      gitIn(dir, 'checkout', '-q', '-b', 'tmp');
      gitIn(dir, 'commit', '-q', '--allow-empty', '-m', 'backup');
      gitIn(dir, 'update-ref', 'refs/backup/pre-rebase', 'HEAD');
      gitIn(dir, 'checkout', '-q', 'main');
      gitIn(dir, 'branch', '-q', '-D', 'tmp');
    },
    'a local tag on an unpushed commit': (dir) => {
      gitIn(dir, 'checkout', '-q', '--detach');
      gitIn(dir, 'commit', '-q', '--allow-empty', '-m', 'tagged');
      gitIn(dir, 'tag', 'v-local');
      gitIn(dir, 'checkout', '-q', 'main');
    },
  };

  for (const [what, make] of Object.entries(unsafe)) {
    it(`refuses a lane holding ${what}, touching nothing`, async () => {
      const s = await lane();
      make(s.dir);
      writeFileSync(join(s.dir, '.ai', 'plans', 'task.md'), 'plan\n');
      const err = await runTeardown({ lane: 'lane_1', removeDir: true, container: s.container }, s.deps).catch((e) => e);
      expect(err).toBeInstanceOf(BlockedError);
      expect(err.exitCode).toBe(3);
      expect(err.message).toContain('Nothing has been archived or deleted');
      expect(existsSync(join(s.dir, '.ai', 'plans', 'task.md'))).toBe(true);
      expect(state(s).state).toBe('active');
    });
  }

  it('names the refs that hold unpushed commits', async () => {
    const s = await lane();
    unsafe['a commit only in refs/backup'](s.dir);
    const err = await runTeardown({ lane: 'lane_1', removeDir: true, container: s.container }, s.deps).catch((e) => e);
    expect(err.message).toContain('refs/backup/pre-rebase');
  });

  it('--force overrides unpushed work, but never a kept lane', async () => {
    const s = await lane();
    unsafe['uncommitted changes'](s.dir);
    const r = await runTeardown({ lane: 'lane_1', removeDir: true, force: true, container: s.container }, s.deps);
    expect(r).toMatchObject({ removedDir: true, forced: true });
    const k = await lane();
    await runKeep({ lane: 'lane_1', reason: 'stack base', container: k.container }, k.deps);
    await expect(runTeardown({ lane: 'lane_1', removeDir: true, force: true, container: k.container }, k.deps)).rejects.toThrow(/kept/);
    expect(existsSync(k.dir)).toBe(true);
  });

  it('dry run reports what would happen and changes nothing', async () => {
    const s = await lane();
    unsafe['uncommitted changes'](s.dir);
    const r = await runTeardown({ lane: 'lane_1', removeDir: true, dryRun: true, container: s.container }, s.deps);
    expect(r).toMatchObject({ dryRun: true, blocked: true });
    expect(r.checks.problems[0]).toContain('uncommitted');
    expect(existsSync(s.dir)).toBe(true);
    expect(state(s).state).toBe('active');
  });

  it('refuses when the lane directory has been replaced by a symlink out of the container', async () => {
    const s = await lane();
    const outside = tmp();
    writeFileSync(join(outside, 'precious.txt'), 'x\n');
    renameSync(s.dir, join(s.root, 'moved'));
    symlinkSync(outside, s.dir);
    await expect(runTeardown({ lane: 'lane_1', removeDir: true, force: true, container: s.container }, s.deps)).rejects.toBeInstanceOf(BlockedError);
    expect(existsSync(join(outside, 'precious.txt'))).toBe(true);
  });

  it('requires an explicit lane name and wires into the CLI', async () => {
    const s = await lane();
    await expect(runTeardown({ container: s.container }, { ...s.deps, cwd: () => s.dir })).rejects.toBeInstanceOf(InvalidInputError);
    const r = await runCli(['teardown', 'lane_1', '--remove-dir', '--container', s.container, '--format', 'table'], s.deps);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('lane_1 torn down');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/teardown.test.js`
Expected: FAIL — cannot resolve `../src/commands/teardown.js`.

- [ ] **Step 3: Implement**

`src/lib/lane-git.js`:
```js
import { gitOut } from './git.js';

// The loss condition is commit-level, not branch-level: any commit reachable from a local ref but
// on no remote dies with the clone. Comparing against upstream misses branches with no upstream,
// and walking refs/heads misses backup refs and tags. Stashes are counted on their own.
export function unpushedWork(deps, laneDir) {
  const g = (args) => gitOut(deps, args, laneDir);
  const lines = (s) => s.split('\n').filter(Boolean);
  const dirty = lines(g(['status', '--porcelain']));
  const stashes = lines(g(['stash', 'list'])).length;
  const unpushed = Number(g(['rev-list', '--count', '--exclude=refs/stash', '--all', '--not', '--remotes']).trim()) || 0;
  const refs = unpushed === 0
    ? []
    : lines(g(['for-each-ref', '--format=%(refname)']))
      .filter((ref) => !ref.startsWith('refs/remotes/') && ref !== 'refs/stash')
      .map((ref) => ({ ref, commits: Number(g(['rev-list', '--count', ref, '--not', '--remotes']).trim()) || 0 }))
      .filter((r) => r.commits > 0);
  const branch = g(['branch', '--show-current']).trim();
  const noUpstream = branch && deps.git(['rev-parse', '--abbrev-ref', '@{u}'], { cwd: laneDir }).status !== 0 ? branch : null;
  const problems = [];
  if (dirty.length) problems.push(`${dirty.length} uncommitted change(s)`);
  if (stashes) problems.push(`${stashes} stash entr${stashes === 1 ? 'y' : 'ies'}`);
  if (unpushed) problems.push(`${unpushed} commit(s) that exist on no remote: ${refs.map((r) => `${r.ref} (${r.commits})`).join(', ')}`);
  return { dirty, stashes, unpushed, refs, noUpstream, problems };
}
```

`src/commands/teardown.js`:
```js
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadContainer } from '../lib/container.js';
import { readLanes, updateLanes } from '../lib/lanes-store.js';
import { assertLaneDir, removeLaneDir } from '../lib/containment.js';
import { untrackedEntries } from '../lib/lane-files.js';
import { unpushedWork } from '../lib/lane-git.js';
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

// Human-only (deny rules in agent settings): the lane must always be named.
export async function runTeardown(opts, deps) {
  if (!opts.lane) throw new InvalidInputError('Name the lane to tear down: `laines teardown <lane>`.');
  const ctx = loadContainer(opts, deps);
  const name = opts.lane;
  const lane = readLanes(ctx).lanes[name];
  if (!lane) throw new InvalidInputError(`No lane named ${name}. See \`laines list --all\`.`);
  if (lane.kept) {
    throw new BlockedError(`Lane ${name} is kept (${lane.kept.reason}). A human must run \`laines release ${name}\` before it can be torn down.`);
  }
  if (lane.state === 'closed' && !opts.removeDir) {
    throw new InvalidInputError(`Lane ${name} is already closed. Pass --remove-dir to delete its clone.`);
  }
  const laneDir = join(ctx.root, lane.repos[0].path);
  const real = assertLaneDir(ctx.root, laneDir, lane.repos[0].path);
  const isRepo = Boolean(real) && existsSync(join(real, '.git'));
  const checks = opts.removeDir && isRepo ? unpushedWork(deps, real) : null;
  const risky = Boolean(checks && checks.problems.length);
  const blocked = risky && !opts.force;
  const warnings = checks?.noUpstream ? [`branch ${checks.noUpstream} has no upstream`] : [];

  if (opts.dryRun) {
    return { dryRun: true, lane: name, path: laneDir, blocked, removeDir: Boolean(opts.removeDir && real), forced: risky && Boolean(opts.force), checks, warnings };
  }
  if (blocked) {
    throw new BlockedError([
      `Refusing to remove ${laneDir}:`,
      ...checks.problems.map((p) => `  - ${p}`),
      `Push the work, or save it first: git -C ${laneDir} bundle create <file> --all --not --remotes`,
      'Nothing has been archived or deleted. Use --force only after confirming this work can be lost.',
    ].join('\n'));
  }

  // M3: run the pre-teardown hook here; a failure aborts with nothing touched.
  const open = lane.state !== 'closed' && Boolean(real);
  const archivedTo = open ? archivePlans(ctx, deps, real, name) : null;
  const contextDeleted = open ? deleteContext(deps, real) : false;
  const now = deps.now();
  if (lane.state !== 'closed') {
    await updateLanes(ctx, deps, (state) => {
      const l = state.lanes[name];
      l.state = 'closed';
      l.status = 'closed';
      l.blocked = null;
      l.closed = now;
      l.updated = now;
      state.requests = state.requests.filter((q) => q.lane !== name);
      const note = archivedTo ? `plans archived to ${archivedTo}` : 'no plans to archive';
      return { state, result: null, activity: [{ ts: now, lane: name, text: `lane torn down; ${note}` }] };
    });
  }
  const removedDir = opts.removeDir ? removeLaneDir(ctx.root, laneDir, lane.repos[0].path) : false;
  // M3: run the post-teardown hook here.
  const forced = risky && Boolean(opts.force);
  appendAudit(ctx.paths.audit, { ts: now, action: 'teardown', container: ctx.id, lane: name, removedDir, forced }, { warn: deps.warn });
  return { dryRun: false, lane: name, path: laneDir, archivedTo, contextDeleted, removedDir, forced, checks, warnings };
}
```

`src/lib/format.js` — append:
```js
export function formatTeardown(r) {
  if (r.dryRun) {
    const lines = [`dry run: ${r.blocked ? 'teardown would be refused' : `would tear down ${r.lane}`}`];
    for (const p of r.checks?.problems ?? []) lines.push(`  - ${p}`);
    if (r.removeDir) lines.push(`would remove ${r.path}`);
    return lines.join('\n');
  }
  const lines = [`${r.lane} torn down`];
  lines.push(r.archivedTo ? `plans archived to ${r.archivedTo}` : 'no plans to archive');
  if (r.removedDir) lines.push(`removed ${r.path}${r.forced ? ' (forced)' : ''}`);
  else lines.push(`clone left at ${r.path}`);
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  return lines.join('\n');
}
```

`src/cli.js` — import `runTeardown` and `formatTeardown`, and register after `status`:
```js
  withGlobals(program.command('teardown'))
    .description('Close a lane: archive plans, delete context, and optionally remove the clone (human-only)')
    .argument('<lane>', 'lane name')
    .option('--remove-dir', 'also delete the clone, after the unpushed-work checks')
    .option('--force', 'remove even if the lane holds unpushed work (never overrides keep)')
    .option('--dry-run', 'show what would happen without changing anything')
    .action(handle(runTeardown, { table: formatTeardown, args: ['lane'] }, deps));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/teardown.test.js` then `npm run test:run && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/lane-git.js src/commands/teardown.js src/lib/format.js src/cli.js test/teardown.test.js
git commit -m "feat: laines teardown with unpushed-work and containment checks" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: `watch`

**Files:**
- Create: `src/commands/watch.js`
- Modify: `src/cli.js` (extract `reportError`, register `watch`)
- Test: `test/watch.test.js`

**Interfaces:**
- Consumes: `loadContainer` (Task 2), `InvalidInputError`, `LainesError`, `EXIT_CODES`.
- Produces:
  - `newLines(prev, next) → string[]` (non-blank lines of `next` not present in `prev`)
  - `runWatch({ file?, interval?, container? }, deps, { signal, write, intervalMs? }) → Promise<{ file, updates }>` — polls; prints `--- <timestamp> <basename> ---` then the new lines on each change; returns when `signal` aborts
  - `reportError(err)` in `src/cli.js` (the error half of `handle()`, shared with `watch`)
  - CLI: `laines watch [file] [--interval <seconds>] [--container <dir>]` (runs until Ctrl-C; not JSON)

- [ ] **Step 1: Write the failing test**

`test/watch.test.js`:
```js
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newLines, runWatch } from '../src/commands/watch.js';
import { InvalidInputError } from '../src/lib/errors.js';
import { tmp, cleanupTmp, testDeps } from './helpers.js';

afterEach(cleanupTmp);

describe('watch', () => {
  it('finds new lines only', () => {
    expect(newLines('a\nb\n', 'b\na\nc\n\n')).toEqual(['c']);
    expect(newLines('a\n', 'a\n')).toEqual([]);
  });

  it('prints new lines as the file changes and stops on abort', async () => {
    const root = tmp();
    const file = join(root, 'board.md');
    writeFileSync(file, '# board\n');
    const out = [];
    const ac = new AbortController();
    const done = runWatch({ file }, testDeps(root), { signal: ac.signal, write: (s) => out.push(s), intervalMs: 20 });
    await new Promise((r) => setTimeout(r, 60));
    writeFileSync(file, '# board\n- lane_1: started\n');
    await new Promise((r) => setTimeout(r, 120));
    ac.abort();
    const r = await done;
    expect(r).toEqual({ file, updates: 1 });
    expect(out.join('')).toContain('- lane_1: started');
    expect(out.join('')).toContain('board.md');
  });

  it('refuses a missing file and a bad interval', async () => {
    const root = tmp();
    const deps = testDeps(root);
    const ac = new AbortController();
    await expect(runWatch({ file: 'nope.md' }, deps, { signal: ac.signal, write: () => {} })).rejects.toBeInstanceOf(InvalidInputError);
    writeFileSync(join(root, 'f.md'), 'x');
    await expect(runWatch({ file: 'f.md', interval: '0' }, deps, { signal: ac.signal, write: () => {} })).rejects.toBeInstanceOf(InvalidInputError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/watch.test.js`
Expected: FAIL — cannot resolve `../src/commands/watch.js`.

- [ ] **Step 3: Implement**

`src/commands/watch.js`:
```js
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { loadContainer } from '../lib/container.js';
import { InvalidInputError } from '../lib/errors.js';

export function newLines(prev, next) {
  const seen = new Set(prev.split('\n'));
  return next.split('\n').filter((line) => line.trim() && !seen.has(line));
}

const sleep = (ms, signal) =>
  new Promise((done) => {
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      done();
    }, { once: true });
  });

// The board is regenerated wholesale on every write, so "what's new" is a line-set difference.
export async function runWatch(opts, deps, { signal, write, intervalMs } = {}) {
  const file = opts.file ? resolve(deps.cwd(), opts.file) : loadContainer(opts, deps).paths.board;
  if (!existsSync(file)) throw new InvalidInputError(`File not found: ${file}`);
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
    if (cur === prev) continue;
    const lines = newLines(prev, cur);
    prev = cur;
    if (!lines.length) continue;
    updates += 1;
    write(`--- ${deps.now()} ${basename(file)} ---\n${lines.join('\n')}\n\n`);
  }
  return { file, updates };
}
```

`src/cli.js` — extract the error branch of `handle()` into a shared function and use it in both places:
```js
function reportError(err) {
  if (err instanceof LainesError) {
    process.stderr.write(err.message + '\n');
    process.exitCode = err.exitCode;
  } else {
    process.stderr.write(((err && (err.stack || err.message)) || String(err)) + '\n');
    process.exitCode = EXIT_CODES.GENERIC;
  }
}
```
(`handle()`'s `catch (err)` body becomes `reportError(err);`.) Then import `runWatch` and register after `teardown`:
```js
  program
    .command('watch')
    .description('Follow the board (or any file) and print new lines as they land')
    .argument('[file]', 'file to watch (default: the container board)')
    .option('--interval <seconds>', 'polling interval', '2')
    .option('--container <dir>', 'container directory (default: current directory)')
    .action(async (file, cmdOpts) => {
      const ac = new AbortController();
      const stop = () => ac.abort();
      process.once('SIGINT', stop);
      try {
        await runWatch({ ...cmdOpts, file }, deps, { signal: ac.signal, write: (s) => process.stdout.write(s) });
      } catch (err) {
        reportError(err);
      } finally {
        process.off('SIGINT', stop);
      }
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/watch.test.js` then `npm run test:run && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/watch.js src/cli.js test/watch.test.js
git commit -m "feat: laines watch" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: `doctor` lane checks, agent reach, docs

**Files:**
- Modify: `src/commands/doctor.js`, `test/doctor.test.js`, `README.md`, `.ai/plans/2026-09-29-laines-roadmap.md`, `.ai/notes/m1-deferred-findings.md`
- Test: `test/doctor.test.js` (new cases, updated check-name list)

**Interfaces:**
- Consumes: `readLanes` (Task 3), `isTracked`, `EXCLUDE_BEGIN` (Task 4), `denyRules`, `AGENT_FILES` (M1).
- Produces: `runDoctor` adds, after `machine-lock`:
  - `lanes-state` — `lanes.json` parses (detail: `<N> open lane(s)`)
  - `lane:<name>` for each non-closed lane — fails listing: clone missing; lane marker missing or wrong; `.laines.env` missing; exclude block missing; Claude deny rules missing from `.claude/settings.local.json` (unless that file is tracked by the repo); a full `.ai/` layer scaffolded in the lane (`knowledge/`, `guidelines/` or `lessons/` present and not tracked — `dot-ai init`/`sync` was run in the lane)
  - `agent-reach` — informational, never fails: for Claude, "container CLAUDE.md reaches every lane"; for Codex/Gemini, how many lanes have the lane-local `AGENTS.md`/`GEMINI.md` and how many rely on `.ai/README.md` because the repository commits its own file

- [ ] **Step 1: Write the failing tests**

In `test/doctor.test.js`, update the fresh-container expected check-name list to:
```js
['container-marker', 'config', 'machine-index', 'dot-ai', 'agent-files', 'deny-rules', 'board', 'lock', 'machine-lock', 'lanes-state', 'agent-reach']
```
and add (importing `rmSync`, `mkdirSync` from `node:fs`, `runCreate` from `../src/commands/create.js`, and `setupContainer` from `./helpers.js`):
```js
describe('doctor lane checks', () => {
  it('checks each open lane and reports agent reach', async () => {
    const { deps, container } = await setupContainer({ agents: 'claude,codex' });
    await runCreate({ container }, deps);
    const r = await runDoctor({ container }, deps);
    const names = r.checks.map((c) => c.name);
    expect(names).toContain('lane:lane_1');
    expect(r.checks.find((c) => c.name === 'lane:lane_1').ok).toBe(true);
    const reach = r.checks.find((c) => c.name === 'agent-reach');
    expect(reach.ok).toBe(true);
    expect(reach.detail).toContain('claude');
    expect(reach.detail).toContain('codex: 1/1 lane(s) have AGENTS.md');
    expect(r.ok).toBe(true);
  });

  it('flags a broken lane: missing env file, stray dot-ai scaffolding, missing clone', async () => {
    const { deps, container } = await setupContainer();
    const one = await runCreate({ container }, deps);
    const two = await runCreate({ container }, deps);
    rmSync(join(one.path, '.laines.env'));
    mkdirSync(join(one.path, '.ai', 'knowledge'));
    rmSync(two.path, { recursive: true, force: true });
    const r = await runDoctor({ container }, deps);
    const byName = Object.fromEntries(r.checks.map((c) => [c.name, c]));
    expect(r.ok).toBe(false);
    expect(byName['lane:lane_1'].ok).toBe(false);
    expect(byName['lane:lane_1'].detail).toContain('.laines.env missing');
    expect(byName['lane:lane_1'].detail).toContain('dot-ai');
    expect(byName['lane:lane_2'].detail).toContain('clone missing');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/doctor.test.js`
Expected: FAIL — `lanes-state`/`agent-reach` checks don't exist.

- [ ] **Step 3: Implement**

In `src/commands/doctor.js`, add imports:
```js
import { readLanes } from '../lib/lanes-store.js';
import { EXCLUDE_BEGIN, isTracked } from '../lib/lane-files.js';
```
and add a helper above `runDoctor`:
```js
function laneProblems(root, containerId, name, lane, agents, deps) {
  const dir = join(root, lane.repos[0].path);
  if (!existsSync(dir)) return ['clone missing'];
  const problems = [];
  const has = (rel) => existsSync(join(dir, rel));
  let marker = null;
  try {
    marker = JSON.parse(readFileSync(join(dir, '.ai', '.lane.json'), 'utf8'));
  } catch {}
  if (!marker || marker.lane !== name || marker.containerId !== containerId) problems.push('lane marker .ai/.lane.json missing or wrong');
  if (!has('.laines.env')) problems.push('.laines.env missing');
  const exclude = deps.git(['rev-parse', '--git-path', 'info/exclude'], { cwd: dir });
  const excludeFile = exclude.status === 0 ? join(dir, exclude.stdout.trim()) : null;
  if (!excludeFile || !existsSync(excludeFile) || !readFileSync(excludeFile, 'utf8').includes(EXCLUDE_BEGIN)) {
    problems.push('git exclude block missing (lane files may show in git status)');
  }
  if (agents.includes('claude') && !isTracked(deps, dir, '.claude/settings.local.json')) {
    const deny = (() => {
      try {
        return JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'))?.permissions?.deny ?? [];
      } catch {
        return [];
      }
    })();
    if (denyRules().some((r) => !deny.includes(r))) problems.push('Claude deny rules missing from .claude/settings.local.json');
  }
  const stray = ['knowledge', 'guidelines', 'lessons'].filter((f) => has(join('.ai', f)) && !isTracked(deps, dir, `.ai/${f}`));
  if (stray.length) problems.push(`a full .ai/ layer was scaffolded in the lane (${stray.join(', ')}): dot-ai init/sync was run there; move anything useful to the container's .ai/ and delete them`);
  return problems;
}
```
(`exclude.stdout` from `--git-path` is relative to the lane or absolute; if absolute, `join(dir, abs)` would be wrong — use `isAbsolute` from `node:path`: `const rel = exclude.stdout.trim(); const excludeFile = exclude.status === 0 ? (isAbsolute(rel) ? rel : join(dir, rel)) : null;`.)

Then, at the end of `runDoctor` after the `machine-lock` check:
```js
  let lanesState = null;
  check('lanes-state', () => {
    lanesState = readLanes({ paths: p });
    const open = Object.values(lanesState.lanes).filter((l) => l.state !== 'closed').length;
    return `${open} open lane(s)`;
  });
  const agents = config ? config.agents : ['claude'];
  const openLanes = Object.entries(lanesState?.lanes ?? {}).filter(([, l]) => l.state !== 'closed');
  for (const [name, lane] of openLanes) {
    check(`lane:${name}`, () => {
      const problems = laneProblems(root, marker?.id, name, lane, agents, deps);
      if (problems.length) throw new Error(problems.join('; '));
      return 'ok';
    });
  }
  // Informational: Claude reads the container CLAUDE.md from every lane; Codex and Gemini stop at
  // the git root, so they rely on a lane-local file or on .ai/README.md.
  const reach = [];
  if (agents.includes('claude')) reach.push('claude: container CLAUDE.md reaches every lane');
  for (const [agent, file] of [['codex', 'AGENTS.md'], ['gemini', 'GEMINI.md']]) {
    if (!agents.includes(agent)) continue;
    const dirs = openLanes.map(([, l]) => join(root, l.repos[0].path)).filter((d) => existsSync(d));
    const local = dirs.filter((d) => existsSync(join(d, file)) && !isTracked(deps, d, file)).length;
    reach.push(`${agent}: ${local}/${dirs.length} lane(s) have ${file}; the rest rely on .ai/README.md`);
  }
  result.checks.push({ name: 'agent-reach', ok: true, detail: reach.join('; ') });
```
(`result.container = …` stays the last statement.)

`README.md` — in the Commands table, add rows for `create [name] [--branch] [--dry-run]`, `list [--all]`, `status [lane]`, `report [lane] --status/--task/--blocked/--note`, `brief [lane]`, `keep [lane] --reason`, `release <lane>` (human-only), `teardown <lane> [--remove-dir] [--force] [--dry-run]` (human-only; describe the unpushed-work refusal), `watch [file] [--interval]`; change the status note at the top to "Containers and lanes work today. Hooks and the MCP server are being built."; add a "Quick start" continuation showing `laines create`, `laines report lane_1 --status in-progress --task "..."` and `laines teardown lane_1 --remove-dir`; mark M2 ✅ Done in the roadmap table.

`.ai/plans/2026-09-29-laines-roadmap.md` — add `✅ done` after `written after M1` in the M2 row's Plan column, and put this plan's filename there: `2026-09-29-laines-m2-lanes-plan.md ✅ done`.

`.ai/notes/m1-deferred-findings.md` — delete the "Carry into M2" section (all five items are implemented by Tasks 1, 2, 4 and 6; warnings are returned in results), keeping "Stay deferred".

- [ ] **Step 4: Run tests and the real binary**

Run: `npm run test:run && npm run lint`
Expected: all PASS.

Then an end-to-end run from the real binary against a local bare remote:
```bash
E2E=$(mktemp -d)
git init -q --bare -b main "$E2E/demo.git"
git clone -q "$E2E/demo.git" "$E2E/seed" 2>/dev/null
(cd "$E2E/seed" && echo hi > README.md && git add README.md && git -c user.name=t -c user.email=t@example.com commit -qm init && git push -q origin HEAD:main)
export LAINES_CONFIG_DIR="$E2E/config"
node bin/laines.js init "$E2E/lanes" --remote "$E2E/demo.git" --format table
node bin/laines.js create --container "$E2E/lanes" --format table
node bin/laines.js report lane_1 --status in-progress --task "try it" --container "$E2E/lanes" --format table
node bin/laines.js list --container "$E2E/lanes" --format table
node bin/laines.js doctor --container "$E2E/lanes" --format table
node bin/laines.js teardown lane_1 --remove-dir --container "$E2E/lanes" --format table
```
Expected: `create` prints `lane lane_1 created` with ports `20000–20009` and the brief; `list` shows `lane_1 active in-progress`; `doctor` ends `status: ok` with a `✓ lane:lane_1` line; `teardown` prints `lane_1 torn down` and `removed …/lane_1`. Paste the output into the report.

- [ ] **Step 5: Commit**

```bash
git add src/commands/doctor.js test/doctor.test.js README.md .ai/plans/2026-09-29-laines-roadmap.md .ai/notes/m1-deferred-findings.md
git commit -m "feat: doctor lane checks and agent reach; document lanes" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## After M2

- Update `.ai/plans/README.md` (index row for this plan).
- Write the M3 (hooks) plan against the code as built: the `// M3:` comments in `create.js` and `teardown.js` mark where hooks run.
