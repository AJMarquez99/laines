import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { vi } from 'vitest';
import { runGit, runGitAsync } from '../src/lib/git.js';
import { runInit } from '../src/commands/init.js';
import { runDotAi } from '../src/lib/dotai.js';
import { runHookFile } from '../src/lib/hook-runner.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../src/mcp/server.js';

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
    gitAsync: runGitAsync,
    busyPorts: async () => [],
    runHook: runHookFile,
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

export async function setupContainer({ files, branches, agents, dir = 'lanes' } = {}) {
  const root = tmp();
  mkdirSync(join(root, 'home'));
  const deps = testDeps(root, { runDotAi });
  const remote = makeRemote(root, { files, branches });
  const r = await runInit({ dir, remote, ...(agents ? { agents } : {}) }, deps);
  return { root, deps, remote, container: r.path };
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

// An in-process MCP client connected to a fresh server. Pass `elicit` to declare the elicitation
// capability and answer prompts; omit it for a client that cannot elicit.
export async function connectMcp(deps, { container, elicit } = {}) {
  const server = createServer(deps, { container });
  const client = new Client({ name: 'test', version: '0' }, { capabilities: elicit ? { elicitation: {} } : {} });
  if (elicit) client.setRequestHandler(ElicitRequestSchema, (req) => elicit(req.params));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, call: (name, args = {}) => client.callTool({ name, arguments: args }), close: () => client.close() };
}
