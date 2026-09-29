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
  for (let dir = target; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) {
      throw new InvalidInputError(
        `${target} is inside the git repository ${dir}. Create the container outside any repository; lanes are the clones.`,
      );
    }
    if (dir !== target && existsSync(join(dir, '.laines', 'container.json'))) {
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
  for (const [flag, value] of [['--remote', opts.remote], ['--branch', opts.branch]]) {
    if (typeof value === 'string' && value.startsWith('-')) {
      throw new InvalidInputError(`${flag} must not start with "-" (got "${value}"): it is passed to git.`);
    }
  }
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
