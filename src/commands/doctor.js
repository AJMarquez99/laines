import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { readJson } from '../lib/jsonfile.js';
import { configDir, containerPaths } from '../lib/paths.js';
import { indexFiles, loadIndex, pruneIndex } from '../lib/machine-index.js';
import { resolveContainer } from '../lib/container.js';
import { AGENT_FILES, LANES_BEGIN, denyRules } from '../lib/agent-files.js';
import { NotAContainerError } from '../lib/errors.js';

export async function runDoctor(opts, deps) {
  const indexDir = configDir(deps.env, deps.homedir());
  const result = { ok: true, container: null, checks: [] };
  if (opts.prune) result.pruned = (await pruneIndex(indexDir)).map((c) => ({ id: c.id, path: c.path }));

  let root;
  try {
    root = resolveContainer(resolve(deps.cwd(), opts.container ?? '.'));
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

  result.container = { id: marker?.id ?? null, path: root };
  return result;
}
