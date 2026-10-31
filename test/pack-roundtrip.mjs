#!/usr/bin/env node
// Pack round-trip: pack this tree (or take a published spec), install it into a throwaway global
// prefix, and drive the installed copy only through its two bins: --version, init, doctor, create
// twice, an MCP handshake, and teardown. Run as `npm run test:pack`; after a publish, check the
// registry copy with `npm run test:pack -- --from @ajmarquez99/laines@X.Y.Z`.
//
// Not a vitest test on purpose: installing needs registry reads for the dependencies, and the
// vitest suite never touches the network. Everything lives under one temp dir (HOME, config,
// git config, npm userconfig), so the real machine index and containers are never touched.
//
// Usage: node test/pack-roundtrip.mjs [--from <spec>] [--keep]

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

function parseArgs(argv) {
  const opts = { from: null, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') opts.keep = true;
    else if (a === '--from') {
      opts.from = argv[++i];
      if (!opts.from) throw new Error('--from needs a package spec, e.g. @ajmarquez99/laines@1.0.0');
    } else if (a.startsWith('--from=')) opts.from = a.slice('--from='.length);
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

class StepError extends Error {
  constructor(step, message, stderr = '') {
    super(message);
    this.step = step;
    this.stderr = stderr;
  }
}

const opts = (() => {
  try {
    return parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\nusage: node test/pack-roundtrip.mjs [--from <spec>] [--keep]\n`);
    process.exit(2);
  }
})();

// Read before HOME is overridden, so a warm cache still serves the install.
const npmCache = spawnSync('npm', ['config', 'get', 'cache'], { encoding: 'utf8' }).stdout.trim();

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'laines-pack-')));
const home = join(sandbox, 'home');
const prefix = join(sandbox, 'prefix');
const userconfig = join(sandbox, 'npmrc');
mkdirSync(home);
writeFileSync(userconfig, '');

const env = {
  PATH: process.env.PATH,
  HOME: home,
  USERPROFILE: home,
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
  XDG_CONFIG_HOME: join(sandbox, 'xdg'),
  LAINES_CONFIG_DIR: join(sandbox, 'laines-config'),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'laines pack test',
  GIT_AUTHOR_EMAIL: 'pack-test@example.invalid',
  GIT_COMMITTER_NAME: 'laines pack test',
  GIT_COMMITTER_EMAIL: 'pack-test@example.invalid',
  GIT_TERMINAL_PROMPT: '0',
  npm_config_userconfig: userconfig,
  npm_config_cache: npmCache,
  npm_config_update_notifier: 'false',
  NO_COLOR: '1',
};

const laines = join(prefix, 'bin', 'laines');
const lainesMcp = join(prefix, 'bin', 'laines-mcp');

function run(step, cmd, args, { cwd = sandbox, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new StepError(step, `${cmd} failed to start: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) throw new StepError(step, `\`${cmd} ${args.join(' ')}\` exited ${r.status}`, r.stderr || r.stdout);
  return r;
}

function json(step, r) {
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new StepError(step, `output is not JSON: ${r.stdout.slice(0, 500)}`, r.stderr);
  }
}

function check(step, cond, message) {
  if (!cond) throw new StepError(step, message);
}

function log(line) {
  process.stdout.write(`pack-roundtrip: ${line}\n`);
}

// 1. Pack (unless --from) and check the file list.
function pack() {
  const step = 'pack';
  const r = run(step, 'npm', ['pack', '--json', '--pack-destination', sandbox], { cwd: repoRoot });
  const [info] = json(step, r);
  const files = info.files.map((f) => f.path);
  const templates = spawnSync('git', ['ls-files', 'templates'], { cwd: repoRoot, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  check(step, templates.length > 0, 'git ls-files found no templates/ files');
  for (const want of ['package.json', 'README.md', 'LICENSE', 'bin/laines.js', 'bin/laines-mcp.js', ...templates]) {
    check(step, files.includes(want), `tarball is missing ${want}`);
  }
  const stray = files.filter((f) => /^(test|\.ai|\.github)\//.test(f));
  check(step, stray.length === 0, `tarball ships files it must not: ${stray.join(', ')}`);
  log(`packed ${info.filename} (${files.length} files)`);
  return join(sandbox, info.filename);
}

// 2. Install into a clean global prefix. --offline first; after `npm ci` the cache usually lacks
// packuments (ENOTCACHED), so fall back to --prefer-offline (registry GETs only).
function install(spec) {
  const step = 'install';
  const base = ['install', '-g', '--prefix', prefix, spec, '--no-audit', '--no-fund', '--ignore-scripts'];
  const offline = run(step, 'npm', [...base, '--offline'], { allowFail: true });
  if (offline.status === 0) {
    log('installed (offline)');
    return;
  }
  run(step, 'npm', [...base, '--prefer-offline']);
  log('installed (prefer-offline)');
}

// 3. Both bins exist, are executable, and report the version.
function checkBins(expected) {
  const step = 'bins';
  for (const bin of [laines, lainesMcp]) {
    check(step, existsSync(bin), `${bin} does not exist`);
    check(step, (statSync(bin).mode & 0o111) !== 0, `${bin} is not executable`);
  }
  const version = run(step, laines, ['--version']).stdout.trim();
  check(step, version === expected, `laines --version printed ${version}, expected ${expected}`);
  log(`laines --version = ${version}`);
}

function seedRemote() {
  const step = 'seed remote';
  const bare = join(sandbox, 'remote.git');
  const seed = join(sandbox, 'seed');
  run(step, 'git', ['init', '-q', '--bare', '-b', 'main', bare]);
  run(step, 'git', ['init', '-q', '-b', 'main', seed]);
  writeFileSync(join(seed, 'README.md'), '# pack round-trip fixture\n');
  run(step, 'git', ['add', 'README.md'], { cwd: seed });
  run(step, 'git', ['commit', '-q', '-m', 'init'], { cwd: seed });
  const url = `file://${bare}`;
  run(step, 'git', ['push', '-q', url, 'main'], { cwd: seed });
  return url;
}

// 7. MCP handshake over stdio: initialize, initialized, tools/list, then stdin close must exit.
async function mcpHandshake(container, expected) {
  const step = 'mcp handshake';
  const child = spawn(lainesMcp, ['--container', container], { cwd: sandbox, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const pending = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const request = (id, method, params) =>
    Promise.race([
      new Promise((resolve) => {
        pending.set(id, resolve);
        send({ jsonrpc: '2.0', id, method, params });
      }),
      exited.then(({ code, signal }) => {
        throw new StepError(step, `laines-mcp exited (${signal ?? code}) before answering ${method}`, stderr);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new StepError(step, `no answer to ${method} within 15 s`, stderr)), 15000).unref()),
    ]);

  try {
    const init = await request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'laines-pack-roundtrip', version: '0.0.0' },
    });
    check(step, !init.error, `initialize failed: ${JSON.stringify(init.error)}`);
    const serverVersion = init.result?.serverInfo?.version;
    check(step, serverVersion === expected, `serverInfo.version is ${serverVersion}, expected ${expected}`);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const list = await request(2, 'tools/list', {});
    check(step, !list.error, `tools/list failed: ${JSON.stringify(list.error)}`);
    const names = (list.result?.tools ?? []).map((t) => t.name);
    for (const want of ['laines_create', 'laines_teardown']) check(step, names.includes(want), `tools/list lacks ${want}: ${names.join(', ')}`);
    const humanOnly = ['laines_release', 'laines_hooks_approve', 'laines_hooks_policy', 'laines_config_set', 'laines_adopt'];
    const leaked = names.filter((n) => humanOnly.includes(n));
    check(step, leaked.length === 0, `tools/list exposes human-only commands: ${leaked.join(', ')}`);
    log(`mcp: serverInfo.version = ${serverVersion}, ${names.length} tools`);
  } catch (err) {
    child.kill('SIGTERM');
    throw err instanceof StepError ? err : new StepError(step, err.message, stderr);
  }

  child.stdin.end();
  const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000).unref());
  const outcome = await Promise.race([exited, timeout]);
  if (outcome === 'timeout') {
    child.kill('SIGTERM');
    throw new StepError(step, 'laines-mcp did not exit on stdin close within 5 s', stderr);
  }
  log('mcp: exited on stdin close');
}

async function main() {
  const spec = opts.from ?? pack();
  install(spec);

  // With --from, the expected version is the one installed, compared against the spec if it names one.
  const installedPkg = JSON.parse(readFileSync(join(prefix, 'lib', 'node_modules', '@ajmarquez99', 'laines', 'package.json'), 'utf8'));
  const expected = opts.from ? installedPkg.version : pkg.version;
  if (opts.from) {
    const pinned = /@(\d+\.\d+\.\d+[^@/]*)$/.exec(opts.from)?.[1];
    if (pinned) check('install', installedPkg.version === pinned, `installed ${installedPkg.version}, expected ${pinned}`);
  } else {
    check('install', installedPkg.version === pkg.version, `installed ${installedPkg.version}, expected ${pkg.version}`);
  }
  checkBins(expected);

  // 4. init, using the bundled dot-ai from the installed copy's own dependencies.
  const remote = seedRemote();
  const container = join(sandbox, 'c');
  json('init', run('init', laines, ['init', container, '--remote', remote, '--agents', 'claude']));
  log('init ok');

  // 5. doctor: every check ok (warnings and notes allowed).
  const doctor = json('doctor', run('doctor', laines, ['doctor', '--container', container]));
  const failed = (doctor.checks ?? []).filter((c) => c.ok !== true);
  check('doctor', doctor.ok === true && failed.length === 0, `doctor checks failed: ${failed.map((c) => `${c.name}: ${c.detail}`).join('; ') || 'ok is false'}`);
  log(`doctor ok (${doctor.checks.length} checks)`);

  // 6. Two lanes with distinct ports and env files.
  const lanes = [1, 2].map(() => json('create', run('create', laines, ['create', '--container', container])));
  for (const l of lanes) {
    check('create', existsSync(join(l.path, '.git')), `lane ${l.lane} has no clone at ${l.path}`);
    check('create', existsSync(join(l.path, '.laines.env')), `lane ${l.lane} has no .laines.env`);
  }
  const [a, b] = lanes;
  check('create', a.lane !== b.lane && a.path !== b.path, `the two lanes collide: ${a.lane} / ${b.lane}`);
  check('create', a.ports[1] < b.ports[0] || b.ports[1] < a.ports[0], `port ranges overlap: ${a.ports} / ${b.ports}`);
  const envA = readFileSync(join(a.path, '.laines.env'), 'utf8');
  const envB = readFileSync(join(b.path, '.laines.env'), 'utf8');
  check('create', envA !== envB, 'the two lanes have identical .laines.env files');
  log(`create ok: ${a.lane} ${a.ports.join('-')}, ${b.lane} ${b.ports.join('-')}`);

  await mcpHandshake(container, expected);

  // 8. Teardown of the second lane: fresh from main, so no --force needed.
  run('teardown', laines, ['teardown', b.lane, '--container', container]);
  check('teardown', !existsSync(b.path), `clone ${b.path} still exists after teardown`);
  log(`teardown ok: ${b.lane}`);
}

let exitCode = 0;
try {
  await main();
  log(`PASS (${opts.from ?? 'packed tree'})`);
} catch (err) {
  exitCode = 1;
  const step = err instanceof StepError ? err.step : 'unexpected';
  process.stderr.write(`pack-roundtrip: FAIL at step "${step}": ${err.message}\n`);
  if (err.stderr) process.stderr.write(`--- stderr ---\n${String(err.stderr).trimEnd()}\n--------------\n`);
  if (!(err instanceof StepError)) process.stderr.write(`${err.stack}\n`);
  process.stderr.write(`pack-roundtrip: sandbox ${sandbox}${opts.keep ? ' (kept)' : ' (removed; rerun with --keep to inspect it)'}\n`);
} finally {
  if (opts.keep) log(`sandbox kept at ${sandbox}`);
  else rmSync(sandbox, { recursive: true, force: true });
}
process.exit(exitCode);
