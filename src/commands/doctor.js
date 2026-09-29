import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { loadConfig } from '../config.js';
import { readJson } from '../lib/jsonfile.js';
import { configDir, containerPaths } from '../lib/paths.js';
import { indexFiles, loadIndex, pruneIndex } from '../lib/machine-index.js';
import { containerDirFrom, resolveContainer } from '../lib/container.js';
import { AGENT_FILES, LANES_BEGIN, denyRules } from '../lib/agent-files.js';
import { readLanes } from '../lib/lanes-store.js';
import { EXCLUDE_BEGIN, isTracked } from '../lib/lane-files.js';
import { NotAContainerError } from '../lib/errors.js';

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
  if (exclude.status !== 0) return ['clone is not a git repository'];
  const rel = exclude.stdout.trim();
  const excludeFile = isAbsolute(rel) ? rel : join(dir, rel);
  if (!existsSync(excludeFile) || !readFileSync(excludeFile, 'utf8').includes(EXCLUDE_BEGIN)) {
    problems.push('git exclude block missing (lane files may show in git status)');
  }
  const settingsTracked = agents.includes('claude') && isTracked(deps, dir, '.claude/settings.local.json');
  if (settingsTracked) problems.push('.claude/settings.local.json is tracked by the repository: lane deny rules cannot be written');
  if (agents.includes('claude') && !settingsTracked) {
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

export async function runDoctor(opts, deps) {
  const indexDir = configDir(deps.env, deps.homedir());
  const result = { ok: true, container: null, checks: [] };
  if (opts.prune) result.pruned = (await pruneIndex(indexDir)).map((c) => ({ id: c.id, path: c.path }));

  let root;
  try {
    root = resolveContainer(containerDirFrom(opts, deps));
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
    const entry = loadIndex(indexDir).containers.find((c) => c.path === root);
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
  check('machine-lock', () => {
    const { lock } = indexFiles(indexDir);
    if (existsSync(lock)) throw new Error(`machine-index lock held at ${lock}; if no laines command is running, remove it: rmdir '${lock}'`);
    return 'free';
  });
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
  const localFile = (d, file) => {
    if (!existsSync(join(d, file))) return false;
    try {
      return !isTracked(deps, d, file);
    } catch {
      return false;
    }
  };
  const reach = [];
  if (agents.includes('claude')) reach.push('claude: container CLAUDE.md reaches every lane');
  for (const [agent, file] of [['codex', 'AGENTS.md'], ['gemini', 'GEMINI.md']]) {
    if (!agents.includes(agent)) continue;
    const dirs = openLanes.map(([, l]) => join(root, l.repos[0].path)).filter((d) => existsSync(d));
    const local = dirs.filter((d) => localFile(d, file)).length;
    reach.push(`${agent}: ${local}/${dirs.length} lane(s) have ${file}; the rest rely on .ai/README.md`);
  }
  result.checks.push({ name: 'agent-reach', ok: true, detail: reach.join('; ') });

  result.container = { id: marker?.id ?? null, path: root };
  return result;
}
