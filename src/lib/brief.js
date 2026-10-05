import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { laneBlock } from './board.js';
import { laneId } from './ids.js';
import { commitsUnder } from './lane-files.js';

// Spec §7.4: a subagent inherits the parent's cwd and instructions, not the lane's, so the brief
// carries everything it needs to work in the lane.
export function buildBrief(ctx, name, lane, deps) {
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
  const plansRule = commitsUnder(deps, laneDir, '.ai/plans')
    ? 'This repository commits `.ai/plans/`: commit plans with your work.'
    : 'Plans in `.ai/plans/` stay local to this lane.';
  const rules = [
    `Work only inside ${laneDir}: use \`git -C ${laneDir}\` or cd into it. Never edit other lanes or the container's .laines/.`,
    `Source ${envFile} before starting services, and use only ports ${start}–${end}.`,
    `Report status with \`laines report ${name} --status "..." --task "..."\` (run it inside the lane, or add --container ${ctx.root}).`,
    `Write durable knowledge, guidelines, lessons, data and audits to ${ctx.paths.ai}/, not into the lane.`,
    `If the repository commits .ai/, never edit the lane's .ai/ files by hand: run \`laines ai sync ${name}\` before opening a PR (it moves knowledge both ways).`,
    plansRule,
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
