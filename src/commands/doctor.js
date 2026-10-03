import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { loadConfig } from '../config.js';
import { readJson } from '../lib/jsonfile.js';
import { configDir, containerPaths } from '../lib/paths.js';
import { indexFiles, loadIndex, pruneIndex } from '../lib/machine-index.js';
import { containerDirFrom, resolveContainer } from '../lib/container.js';
import { AGENT_FILES, LANES_BEGIN, denyRules } from '../lib/agent-files.js';
import { readLanes } from '../lib/lanes-store.js';
import { spinUpState } from '../lib/lanes-state.js';
import { EXCLUDE_BEGIN, EXCLUDE_END, LANE_EXCLUDES, isTracked } from '../lib/lane-files.js';
import { MalformedConfigError, NotAContainerError } from '../lib/errors.js';
import { hookStates, isExecutable } from '../lib/hooks.js';
import { hasMcpEntry, mcpAddCommand } from '../lib/mcp-config.js';
import { lockSuggested } from '../lib/hook-events.js';
import { aiDrift, readAiBase, repoCommitsAi } from '../lib/ai-tree.js';

// Informational: a lane whose committed .ai/ differs from the container's shared one.
function aiDriftNote(paths, laneDir, deps, name) {
  try {
    if (!existsSync(join(laneDir, '.git')) || !repoCommitsAi(deps, laneDir)) return null;
    const n = aiDrift(paths.ai, join(laneDir, '.ai'));
    return n ? `ok; .ai/ differs in ${n} file(s): run \`laines ai sync ${name}\`` : null;
  } catch {
    return null;
  }
}

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
  const excludeText = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
  if (!excludeText.includes(EXCLUDE_BEGIN)) {
    problems.push('git exclude block missing (lane files may show in git status)');
  } else {
    const after = excludeText.slice(excludeText.indexOf(EXCLUDE_BEGIN));
    const end = after.indexOf(EXCLUDE_END);
    const block = new Set((end === -1 ? after : after.slice(0, end)).split('\n').map((l) => l.trim()));
    if (LANE_EXCLUDES.some((l) => !block.has(l))) problems.push(`git exclude block outdated: run \`laines refresh ${name}\``);
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
  if (agents.includes('claude') && !isTracked(deps, dir, '.mcp.json')) {
    try {
      if (!hasMcpEntry(join(dir, '.mcp.json'), root)) problems.push(`laines MCP server missing from .mcp.json: run \`laines refresh ${name}\``);
    } catch (err) {
      if (!(err instanceof MalformedConfigError)) throw err;
      problems.push(`.mcp.json is malformed: fix or delete it, then run \`laines refresh ${name}\``);
    }
  }
  const stray = repoCommitsAi(deps, dir) ? [] : ['knowledge', 'guidelines', 'lessons'].filter((f) => has(join('.ai', f)) && !isTracked(deps, dir, `.ai/${f}`));
  if (stray.length) problems.push(`a full .ai/ layer was scaffolded in the lane (${stray.join(', ')}): dot-ai init/sync was run there; move anything useful to the container's .ai/ and delete them`);
  return problems;
}

function laneStateProblems(name, lane, config, deps) {
  const problems = [];
  if (lane.state === 'setup-failed') problems.push(`setup failed: fix the hook, then run \`laines refresh ${name}\``);
  if (spinUpState(lane, config, deps.now()) === 'interrupted') {
    problems.push(`create was interrupted (spinning up since ${lane.updated}): if the clone is complete, run \`laines refresh ${name}\`; otherwise run \`laines teardown ${name} --remove-dir --force\` and create it again`);
  }
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
    if (missing.length) throw new Error(`${missing.length} human-only deny rule(s) missing from .claude/settings.json: run \`laines refresh <lane>\` (any lane) to add them`);
    return `${denyRules().length} rules present`;
  });
  check('mcp', () => {
    const agentsNow = config ? config.agents : ['claude'];
    if (!agentsNow.includes('claude')) return 'not wired (Claude is not a configured agent)';
    const file = join(root, '.mcp.json');
    // Containers made before the MCP server existed have no entry; this is how they get one.
    if (!hasMcpEntry(file, root)) throw new Error(`laines MCP server not registered in ${file}: run \`${mcpAddCommand(root)}\` in ${root}`);
    return 'laines-mcp registered in .mcp.json';
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
  check('hooks', () => {
    const policy = config?.hooks.policy;
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
    const parts = [`policy ${policy ?? 'unknown'}`, hooks.length ? `${hooks.length} hook(s): ${counts.join(', ')}` : 'no hooks'];
    if (removed.length) parts.push(`approved but since removed: ${removed.join(', ')}`);
    const current = Object.fromEntries(hooks.map((h) => [h.rel, h.checksum]));
    if (config && lanesState && lockSuggested(lanesState, config, current)) {
      parts.push(`unchanged across the last ${config.hooks.stableAfter} creates: a human can lock them with \`laines hooks approve --lock\``);
    }
    return parts.join('; ');
  });
  check('ai-sync', () => {
    const base = readAiBase(p);
    const n = Object.keys(base).length;
    return n ? `base covers ${n} file(s)` : 'no .ai/ sync yet';
  });
  const agents = config ? config.agents : ['claude'];
  const openLanes = Object.entries(lanesState?.lanes ?? {}).filter(([, l]) => l.state !== 'closed');
  for (const [name, lane] of openLanes) {
    check(`lane:${name}`, () => {
      const problems = [...laneStateProblems(name, lane, config, deps), ...laneProblems(root, marker?.id, name, lane, agents, deps)];
      if (problems.length) throw new Error(problems.join('; '));
      return aiDriftNote(p, join(root, lane.repos[0].path), deps, name) ?? 'ok';
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

  // Spec §9.5: a Claude Elicitation/ElicitationResult hook can answer or alter a teardown confirmation.
  const settingsFiles = [
    join(root, '.claude', 'settings.json'),
    join(root, '.claude', 'settings.local.json'),
    ...openLanes.flatMap(([, l]) => ['settings.json', 'settings.local.json'].map((f) => join(root, l.repos[0].path, '.claude', f))),
    join(deps.homedir(), '.claude', 'settings.json'),
  ];
  const withElicitationHooks = settingsFiles.filter((f) => {
    try {
      const hooks = JSON.parse(readFileSync(f, 'utf8'))?.hooks;
      return hooks !== null && typeof hooks === 'object' && ['Elicitation', 'ElicitationResult'].some((k) => Object.hasOwn(hooks, k));
    } catch {
      return false;
    }
  });
  result.checks.push({
    name: 'elicitation-hooks',
    ok: true,
    warn: withElicitationHooks.length > 0,
    detail: withElicitationHooks.length
      ? `Claude Elicitation hooks can answer or change teardown confirmations: ${withElicitationHooks.join(', ')}`
      : 'none visible to the lanes',
  });

  result.container = { id: marker?.id ?? null, path: root };
  return result;
}
