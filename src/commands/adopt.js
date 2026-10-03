import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, statSync } from 'node:fs';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { buildConfig } from '../config.js';
import { BlockedError, InvalidInputError, LainesError } from '../lib/errors.js';
import { configDir, containerPaths, shellQuote } from '../lib/paths.js';
import { repoSlugFromRemote, uniqueId, validateId } from '../lib/ids.js';
import { allocateBlock, lanePorts } from '../lib/ports.js';
import { claimContainer, loadIndex, releaseContainer } from '../lib/machine-index.js';
import { gitOut } from '../lib/git.js';
import { loadContainer } from '../lib/container.js';
import { updateLanes } from '../lib/lanes-store.js';
import { isTracked, writeLaneFiles } from '../lib/lane-files.js';
import { operationInProgress } from '../lib/lane-git.js';
import { copyTree, syncedState, walk, writeAiBase } from '../lib/ai-tree.js';
import { appendAudit } from '../lib/audit.js';
import { CONTAINER_FILES, parseAgents, writeContainer } from './init.js';

// The lane-local files writeLaneFiles will write for these agents; only those can collide.
const collisionCandidates = (agents) => [
  '.laines.env',
  ...(agents.includes('claude') ? ['CLAUDE.local.md'] : []),
  ...(agents.includes('codex') ? ['AGENTS.md'] : []),
  ...(agents.includes('gemini') ? ['GEMINI.md'] : []),
];
const tempPrefix = (name) => `.${name}.laines-adopt-`;
const lastLine = (s) => String(s ?? '').trim().split('\n').filter(Boolean).pop() ?? 'unknown error';

const setupSteps = (dir) =>
  [
    'Lanes are clones of a remote, so adopt needs a git repository with an `origin` it can reach:',
    `  cd ${shellQuote(dir)}`,
    '  git init -b main && git add -A && git commit -m "Initial commit"',
    '  git remote add origin <url>    # an empty repository you created',
    '  git push -u origin main',
    'then run laines adopt again.',
  ].join('\n');

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function isGitDir(p) {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Design §3.1: everything adopt checks before touching anything. Returns where things are.
function inspect(opts, deps) {
  if (!opts.dir) throw new InvalidInputError('Usage: laines adopt <dir>');
  const given = resolve(deps.cwd(), opts.dir);
  // The temp sibling sits next to the real folder, so look beside the realpath of the parent (adopt
  // may be given a symlink whose target has already been moved aside).
  const parent0 = existsSync(dirname(given)) ? realpathSync(dirname(given)) : dirname(given);
  const name0 = existsSync(given) ? basename(realpathSync(given)) : basename(given);
  // A crash between the two renames leaves the project in a hidden sibling: say how to put it back.
  const leftover = existsSync(parent0) ? readdirSync(parent0).find((e) => e.startsWith(tempPrefix(name0))) : undefined;
  if (leftover) {
    throw new BlockedError(
      `An earlier \`laines adopt\` of ${given} was interrupted; the project is in ${join(parent0, leftover)}.\n` +
        `Put it back (remove ${given} first if it exists and holds only a partial container):\n` +
        `  mv ${shellQuote(join(parent0, leftover))} ${shellQuote(given)}`,
    );
  }
  if (!existsSync(given) || !statSync(given).isDirectory()) throw new InvalidInputError(`${given} is not a directory.`);
  const dir = realpathSync(given);
  const home = deps.homedir();
  if (dir === parse(dir).root || (existsSync(home) && dir === realpathSync(home))) throw new InvalidInputError(`Refusing to adopt ${dir}.`);
  if (existsSync(join(dir, '.laines'))) throw new InvalidInputError(`${dir} is already a L.AI.nes container.`);
  const dotGit = join(dir, '.git');
  if (existsSync(dotGit) && !isGitDir(dotGit)) {
    throw new InvalidInputError(`${dir} is a git worktree or submodule (its .git is a file). Adopt the main checkout instead.`);
  }
  if (!existsSync(dotGit)) {
    const interrupted = existsSync(join(dir, 'lane_1', '.git')) ? `\nIf an earlier adopt was interrupted, the project may be in ${join(dir, 'lane_1')}.` : '';
    throw new InvalidInputError(`${dir} is not a git repository.\n${setupSteps(dir)}${interrupted}`);
  }
  const top = realpathSync(gitOut(deps, ['rev-parse', '--show-toplevel'], dir).trim());
  if (top !== dir) throw new InvalidInputError(`${dir} is not the root of its git repository (${top}).`);
  for (let d = dirname(dir); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) throw new InvalidInputError(`${dir} is inside the git repository ${d}. Adopt a top-level checkout.`);
    if (existsSync(join(d, '.laines', 'container.json'))) throw new InvalidInputError(`${dir} is inside the container ${d}.`);
    if (dirname(d) === d) break;
  }
  const origin = deps.git(['remote', 'get-url', 'origin'], { cwd: dir });
  if (origin.status !== 0 || !origin.stdout.trim()) throw new InvalidInputError(`${dir} has no \`origin\` remote.\n${setupSteps(dir)}`);
  const remote = origin.stdout.trim();
  if (remote.startsWith('-')) throw new InvalidInputError(`origin URL must not start with "-" (got "${remote}").`);
  const op = operationInProgress(deps, dir);
  if (op) throw new InvalidInputError(`${dir} has a git operation in progress (${op}). Finish or abort it, then run laines adopt again.`);
  if (isSymlink(join(dir, '.ai'))) {
    throw new InvalidInputError(
      `${dir}/.ai is a symbolic link: laines would write lane files through it. Replace it with a real folder (or remove it), then run laines adopt again.`,
    );
  }
  return { dir, name: basename(dir), parent: dirname(dir), remote };
}

async function assertRemoteReachable(deps, { dir, remote }) {
  const r = await deps.gitAsync(['ls-remote', '--exit-code', '--heads', 'origin'], { cwd: dir });
  if (r.status === 0) return;
  if (r.status === 2) throw new InvalidInputError(`origin (${remote}) has no branches yet: push yours first (git push -u origin <branch>), then run laines adopt again.`);
  throw new InvalidInputError(
    `Cannot reach origin (${remote}): ${lastLine(r.stderr || r.error?.message)}\n` +
      'Lanes are clones of origin, so adopt needs it reachable. Check the URL and your credentials, then run laines adopt again.',
  );
}

// Directories holding pyvenv.cfg, up to three levels down: virtualenvs store absolute paths.
function findVenvs(dir) {
  const found = [];
  const visit = (abs, rel, depth) => {
    if (depth > 3) return;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (existsSync(join(abs, entry.name, 'pyvenv.cfg'))) found.push(childRel);
      else visit(join(abs, entry.name), childRel, depth + 1);
    }
  };
  visit(dir, '', 1);
  return found.sort();
}

function backupName(dir, file) {
  let to = `${file}.pre-laines`;
  for (let i = 2; existsSync(join(dir, to)); i += 1) to = `${file}.pre-laines-${i}`;
  return to;
}

function plan(insp, opts, deps) {
  const { dir, remote } = insp;
  const branchNow = deps.git(['branch', '--show-current'], { cwd: dir }).stdout.trim();
  const head = deps.git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: dir });
  const defaultBranch = head.status === 0 && head.stdout.trim() ? head.stdout.trim().replace(/^origin\//, '') : branchNow || 'main';
  const agents = parseAgents(opts.agents);
  const repoName = repoSlugFromRemote(remote);
  const config = buildConfig({ repoName, remote, defaultBranch, agents });
  const lane = `${config.lanePrefix}1`;
  const aiDir = join(dir, '.ai');
  const hasAi = existsSync(aiDir) && lstatSync(aiDir).isDirectory();
  const aiWalk = hasAi ? walk(aiDir) : { files: [], symlinks: [] };
  const collisions = collisionCandidates(agents).filter((f) => existsSync(join(dir, f)) && !isTracked(deps, dir, f));
  // Stash commits are not "unpushed work": they stay with lane_1 either way (same rule as lane-git.js).
  const unpushed = Number(gitOut(deps, ['rev-list', '--count', '--exclude=refs/stash', '--all', '--not', '--remotes'], dir).trim()) || 0;
  const venvs = findVenvs(dir);
  const warnings = [];
  if (unpushed) warnings.push(`${unpushed} commit(s) exist on no remote: they stay in ${lane}, but new lanes clone origin and won't have them until you push.`);
  if (venvs.length) warnings.push(`Python virtualenv(s) store absolute paths and must be recreated after the move (for uv: uv sync): ${venvs.join(', ')}`);
  if (aiWalk.symlinks.length) warnings.push(`.ai/ symbolic links are not copied to the container: ${aiWalk.symlinks.join(', ')}`);
  return {
    branch: branchNow || defaultBranch,
    agents,
    repoName,
    config,
    lane,
    ai: { mode: hasAi ? 'seed' : 'fresh', files: aiWalk.files.length },
    backups: collisions.map((f) => ({ from: f, to: backupName(dir, f) })),
    warnings,
    venvs,
  };
}

const nextSteps = (laneDir, dir, p) => [
  `cd ${shellQuote(laneDir)}`,
  ...(p.venvs.length ? [`recreate the virtualenv(s) in the lane (e.g. uv sync): ${p.venvs.join(', ')}`] : []),
  `stop dev servers started from the old path and reopen editors on ${laneDir}`,
  `Claude's saved project memory for ${dir} now belongs to the container session`,
  'create more lanes: laines create',
];

// Design §3. Human-only (deny rules). The commit point is the lane's registration: everything before
// it rolls back exactly; after it, failures keep the container and name the fix.
export async function runAdopt(opts, deps) {
  if (opts.id !== undefined) validateId(opts.id);
  const insp = inspect(opts, deps);
  await assertRemoteReachable(deps, insp);
  const p = plan(insp, opts, deps);
  const indexDir = configDir(deps.env, deps.homedir());
  const blockSize = p.config.maxLanes * p.config.ports.stride;
  const laneDir = join(insp.dir, p.lane);
  const summary = (id, portRange, ports, backups) => ({
    id, path: insp.dir, portRange, lane: p.lane, lanePath: laneDir, branch: p.branch, ports,
    remote: insp.remote, ai: p.ai, backups, warnings: p.warnings,
  });

  if (opts.dryRun) {
    const index = loadIndex(indexDir);
    const taken = index.containers.map((c) => c.id);
    if (opts.id !== undefined && taken.includes(opts.id)) throw new InvalidInputError(`Container id "${opts.id}" is already used on this machine. Pick another with --id.`);
    const portRange = allocateBlock({ range: index.machine.range, blockSize }, index.containers.map((c) => c.portRange));
    return { dryRun: true, ...summary(opts.id ?? uniqueId(p.repoName, taken), portRange, lanePorts(portRange, 1, p.config.ports.stride), p.backups), files: CONTAINER_FILES(p.agents), next: [] };
  }

  const entry = await claimContainer(indexDir, { path: insp.dir, id: opts.id, baseId: p.repoName, blockSize, now: deps.now() });
  const ports = lanePorts(entry.portRange, 1, p.config.ports.stride);
  const tmp = join(insp.parent, `${tempPrefix(insp.name)}${deps.now().replace(/[:.]/g, '-')}`);
  const moved = { aside: false, inside: false };
  const laneAi = join(laneDir, '.ai');
  let tracked = [];
  let copied = [];

  const rollback = async () => {
    const problems = [];
    const attempt = (what, fn) => {
      try {
        fn();
      } catch (e) {
        problems.push(`${what}: ${e.message}`);
      }
    };
    if (moved.inside) {
      attempt('removing the partial container', () => {
        for (const e of readdirSync(insp.dir)) if (e !== p.lane) rmSync(join(insp.dir, e), { recursive: true, force: true });
      });
      attempt(`moving ${laneDir} aside`, () => renameSync(laneDir, tmp));
      attempt(`removing ${insp.dir}`, () => rmdirSync(insp.dir));
      attempt(`restoring ${insp.dir}`, () => renameSync(tmp, insp.dir));
    } else if (moved.aside) {
      attempt(`removing ${insp.dir}`, () => existsSync(insp.dir) && rmdirSync(insp.dir));
      attempt(`restoring ${insp.dir}`, () => renameSync(tmp, insp.dir));
    }
    try {
      await releaseContainer(indexDir, entry.id);
    } catch (e) {
      problems.push(`releasing the machine-index entry: ${e.message}`);
    }
    if (!isGitDir(join(insp.dir, '.git'))) problems.push(`${insp.dir} was not restored`);
    return problems;
  };

  try {
    renameSync(insp.dir, tmp);
    moved.aside = true;
    mkdirSync(insp.dir);
    renameSync(tmp, laneDir);
    moved.inside = true;
    let base = null;
    if (p.ai.mode === 'seed') {
      // Copy, never move: the project's files are untouched until the lane is registered.
      ({ copied } = copyTree(laneAi, containerPaths(insp.dir).ai));
      tracked = gitOut(deps, ['ls-files', '-z', '--', '.ai'], laneDir).split('\0').filter(Boolean);
      const trackedSet = new Set(tracked);
      base = Object.fromEntries(Object.entries(syncedState(laneAi).files).filter(([rel]) => trackedSet.has(`.ai/${rel}`)));
    }
    writeContainer({ path: insp.dir, entry, config: p.config, agents: p.agents, deps });
    if (base) writeAiBase(containerPaths(insp.dir), base);
    const ctx = loadContainer({ container: insp.dir }, deps);
    const now = deps.now();
    await updateLanes(ctx, deps, (state) => {
      state.lanes[p.lane] = {
        number: 1,
        repos: [{ name: p.repoName, path: p.lane, branch: p.branch }],
        ports,
        state: 'active',
        status: 'idle',
        task: null,
        blocked: null,
        kept: null,
        created: now,
        updated: now,
        closed: null,
      };
      return { state, result: null, activity: [{ ts: now, lane: p.lane, text: `lane adopted from the existing checkout (branch ${p.branch})` }] };
    });
  } catch (err) {
    const problems = await rollback();
    const restored = problems.length
      ? `Rolling back was incomplete:\n${problems.map((x) => `  - ${x}`).join('\n')}`
      : `Nothing was changed: ${insp.dir} was restored as it was.`;
    throw new LainesError(`${err.message}\n${restored}`, err instanceof LainesError ? err.exitCode : 1);
  }

  // After the commit point: the container exists and the lane is registered.
  const warnings = [...p.warnings];
  try {
    for (const b of p.backups) renameSync(join(laneDir, b.from), join(laneDir, b.to));
    if (p.ai.mode === 'seed') {
      // Exactly the untracked files that were copied now live in the container's shared .ai/; tracked
      // files stay (git owns them). Then drop the folders that emptied, deepest first (never .ai/ itself):
      // an empty untracked .ai/knowledge/ would look like a stray dot-ai scaffold to doctor.
      // A copied file laines then overwrote in the container (its own runbook, templates or board) stays.
      const trackedSet = new Set(tracked);
      const containerAi = containerPaths(insp.dir).ai;
      const kept = [];
      for (const rel of copied) {
        if (trackedSet.has(`.ai/${rel}`)) continue;
        if (readFileSync(join(laneAi, rel)).equals(readFileSync(join(containerAi, rel)))) rmSync(join(laneAi, rel), { force: true });
        else kept.push(rel);
      }
      if (kept.length) warnings.push(`kept in ${p.lane}/.ai/ because laines writes its own version in the container: ${kept.join(', ')}`);
      const dirs = [...new Set(copied.flatMap((rel) => rel.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))))];
      for (const rel of dirs.sort((a, b) => b.split('/').length - a.split('/').length)) {
        const abs = join(laneAi, rel);
        if (existsSync(abs) && readdirSync(abs).length === 0) rmdirSync(abs);
      }
    }
    const ctx = loadContainer({ container: insp.dir }, deps);
    writeLaneFiles(ctx, deps, { name: p.lane, number: 1, laneDir, branch: p.branch, ports });
    const busy = await deps.busyPorts(ports);
    if (busy.length) warnings.push(`lane ports already in use: ${busy.join(', ')}`);
  } catch (err) {
    throw new LainesError(
      `${err.message}\nThe container was created and ${p.lane} registered, but setting up the lane failed part-way. ` +
        `Fix the cause, then run \`laines refresh ${p.lane}\` and \`laines doctor\`.`,
      err instanceof LainesError ? err.exitCode : 1,
    );
  }
  appendAudit(containerPaths(insp.dir).audit, { ts: deps.now(), action: 'adopt', container: entry.id, lane: p.lane, ai: p.ai.mode }, { warn: deps.warn });
  return { dryRun: false, ...summary(entry.id, entry.portRange, ports, p.backups), warnings, files: CONTAINER_FILES(p.agents), next: nextSteps(laneDir, insp.dir, p) };
}
