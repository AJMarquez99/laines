import { z } from 'zod';
import { runTeardownMcp } from './teardown.js';

export const pick = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

const lane = () => z.string().describe('lane name, e.g. lane_2 (default: the lane the server runs in)');
const dryRun = () => z.boolean().optional().describe('report what would happen without changing anything');

// Spec §12: the MCP surface. Each tool names a registry command; mapArgs copies only declared
// arguments, so nothing an agent adds reaches a command. Human-only commands are absent.
export const TOOLS = [
  {
    name: 'laines_create',
    command: 'create',
    description: 'Create a lane: an isolated clone with its own ports, env file and lane files, then run the post-create hook. Returns the lane brief.',
    inputSchema: {
      name: z.string().optional().describe('lane name (default: the next free lane_N)'),
      branch: z.string().optional().describe('branch to check out (default: the container default branch)'),
      dry_run: dryRun(),
    },
    mapArgs: (a) => pick({ name: a.name, branch: a.branch, dryRun: a.dry_run }),
  },
  {
    name: 'laines_refresh',
    command: 'refresh',
    description: "Rewrite a lane's local files and .laines.env, then run post-create again. Recovers a setup-failed lane.",
    inputSchema: { lane: lane().optional(), dry_run: dryRun() },
    mapArgs: (a) => pick({ lane: a.lane, dryRun: a.dry_run }),
  },
  {
    name: 'laines_brief',
    command: 'brief',
    description: 'The handoff for an agent working in a lane: path, branch, ports, env file, files to read first, rules.',
    inputSchema: { lane: lane().optional() },
    mapArgs: (a) => pick({ lane: a.lane }),
  },
  {
    name: 'laines_list',
    command: 'list',
    description: 'List lanes with their state, status, branch and ports.',
    inputSchema: { all: z.boolean().optional().describe('include closed lanes') },
    mapArgs: (a) => pick({ all: a.all }),
  },
  {
    name: 'laines_status',
    command: 'status',
    description: 'One lane in detail, or (with no lane, outside a lane) the container overview with pending requests.',
    inputSchema: { lane: lane().optional() },
    mapArgs: (a) => pick({ lane: a.lane }),
  },
  {
    name: 'laines_report',
    command: 'report',
    description: "Update a lane's board entry. Pass at least one of status, task, blocked, note; \"-\" clears task or blocked.",
    inputSchema: {
      lane: lane().optional(),
      status: z.string().optional().describe('e.g. idle, in-progress, review, done'),
      task: z.string().optional(),
      blocked: z.string().optional(),
      note: z.string().optional().describe('a line for the Activity Log'),
    },
    mapArgs: (a) => pick({ lane: a.lane, status: a.status, task: a.task, blocked: a.blocked, note: a.note }),
  },
  {
    name: 'laines_keep',
    command: 'keep',
    description: 'Pin a lane so it cannot be torn down until a human releases it (e.g. the base of stacked PRs).',
    inputSchema: { lane: lane().optional(), reason: z.string().describe('what depends on this lane') },
    mapArgs: (a) => pick({ lane: a.lane, reason: a.reason }),
  },
  {
    name: 'laines_hooks_status',
    command: 'hooks status',
    description: 'List the hooks as approved, changed or new, with diffs against the approved copies.',
    inputSchema: {},
    mapArgs: () => ({}),
  },
  {
    name: 'laines_config_get',
    command: 'config get',
    description: 'Read the container settings, or one dotted key such as hooks.policy.',
    inputSchema: { key: z.string().optional() },
    mapArgs: (a) => pick({ key: a.key }),
  },
  {
    name: 'laines_doctor',
    command: 'doctor',
    description: 'Check the container, its lanes, hooks and agent wiring.',
    inputSchema: {},
    mapArgs: () => ({}),
  },
  {
    name: 'laines_ai_sync',
    command: 'ai sync',
    description: "Sync the container's shared .ai/ with the lane's committed .ai/ before opening a PR: changes move in both directions; a file changed on both sides is a conflict and is left untouched.",
    inputSchema: { lane: lane().optional(), dry_run: dryRun() },
    mapArgs: (a) => pick({ lane: a.lane, dryRun: a.dry_run }),
  },
  {
    name: 'laines_teardown',
    command: 'teardown',
    description: 'Close a lane: archive its plans, delete its context and its clone (pass keep_dir to keep the clone). A human confirms unless the container is set otherwise; a kept lane is always refused; unpushed work is refused unless a human types the lane name in a second prompt (teardown.mcpForce).',
    inputSchema: {
      lane: z.string().describe('lane name, e.g. lane_2'),
      keep_dir: z.boolean().optional().describe('keep the clone instead of deleting it (deleting is the default, after the unpushed-work checks)'),
      remove_dir: z.boolean().optional().describe('deprecated, ignored: deleting the clone is the default'),
      dry_run: dryRun(),
    },
    mapArgs: (a) => pick({ lane: a.lane, keepDir: a.keep_dir, removeDir: a.remove_dir, dryRun: a.dry_run }),
    handler: runTeardownMcp,
    enabled: (config) => config.teardown.mcp !== 'off',
  },
];
