import { Command } from 'commander';
import { defaultDeps } from './deps.js';
import { VERSION } from './version.js';
import { invoke } from './commands/registry.js';
import { runWatch } from './commands/watch.js';
import { EXIT_CODES, InvalidInputError, LainesError } from './lib/errors.js';
import { printJson, formatInit, formatAdopt, formatConfig, formatDoctor, formatBrief, formatCreate, formatRefresh, formatReport, formatKeep, formatRelease, formatList, formatStatus, formatTeardown, formatHooksStatus, formatHooksApprove, formatHooksPolicy, formatConfigSet, formatAiSync } from './lib/format.js';

function reportError(err) {
  if (err instanceof LainesError) {
    process.stderr.write(err.message + '\n');
    process.exitCode = err.exitCode;
  } else {
    process.stderr.write(((err && (err.stack || err.message)) || String(err)) + '\n');
    process.exitCode = EXIT_CODES.GENERIC;
  }
}

// The single choke point: positionals → opts, global options, rendering, error → exit code.
function handle(name, { table, args } = {}, deps) {
  return async (...actionArgs) => {
    const cmd = actionArgs[actionArgs.length - 1];
    const positionals = actionArgs.slice(0, -2);
    const { format, ...opts } = cmd.opts();
    (args || []).forEach((key, i) => {
      if (positionals[i] !== undefined) opts[key] = positionals[i];
    });
    try {
      if (!['json', 'table'].includes(format)) throw new InvalidInputError(`--format must be json or table (got "${format}").`);
      const result = await invoke(name, opts, deps);
      if (format === 'table' && table) process.stdout.write(table(result) + '\n');
      else printJson(result);
    } catch (err) {
      reportError(err);
    }
  };
}

// Global options live on each leaf command, never on the program: `laines --format json teardown`
// would otherwise slip past `Bash(laines teardown:*)` deny rules.
const withGlobals = (cmd) =>
  cmd
    .option('--format <format>', 'output format: json|table', 'json')
    .option('--container <dir>', 'container directory (default: current directory)');

const withFormat = (cmd) => cmd.option('--format <format>', 'output format: json|table', 'json');

export function buildProgram(deps = defaultDeps) {
  const program = new Command();
  // exitOverride is inherited by subcommands created after this call.
  program.exitOverride();
  program
    .name('laines')
    .description('L.AI.nes: isolated parallel work lanes for coding agents')
    .version(VERSION);

  withFormat(program.command('init'))
    .description('Create a new L.AI.nes container (shared .ai/ layer, board, lane tooling)')
    .argument('<dir>', 'directory to create the container in')
    .option('--remote <url>', 'git URL every lane clones')
    .option('--id <id>', 'machine-unique container id (default: from the repo name)')
    .option('--agents <list>', 'agents to wire: claude,codex,gemini', 'claude')
    .option('--branch <name>', 'default branch for new lanes', 'main')
    .option('--no-seed', 'start the container with a fresh .ai/ layer, without reading the remote')
    .option('--dry-run', 'show what would be created without writing anything')
    .action(handle('init', { table: formatInit, args: ['dir'] }, deps));

  withFormat(program.command('adopt'))
    .description('Turn an existing git checkout into a container, with the checkout as its first lane (human-only)')
    .argument('<dir>', 'the project folder to adopt')
    .option('--id <id>', 'machine-unique container id (default: from the repo name)')
    .option('--agents <list>', 'agents to wire: claude,codex,gemini', 'claude')
    .option('--dry-run', 'show what would happen without changing anything')
    .action(handle('adopt', { table: formatAdopt, args: ['dir'] }, deps));

  const config = program.command('config').description('Read and change container settings');
  withGlobals(config.command('get'))
    .description('Print the container config, or one dotted key')
    .argument('[key]', 'dotted key, e.g. hooks.policy')
    .action(handle('config get', { table: formatConfig, args: ['key'] }, deps));
  withGlobals(config.command('set'))
    .description('Change one setting (human-only)')
    .argument('<key>', 'dotted key, e.g. hooks.timeoutSec')
    .argument('<value>', 'new value: JSON (true, 20, ["claude"]) or a plain string')
    .option('--dry-run', 'show the change without writing it')
    .action(handle('config set', { table: formatConfigSet, args: ['key', 'value'] }, deps));

  withGlobals(program.command('doctor'))
    .description('Check the container, its .ai/ layer, agent wiring and the machine index')
    .option('--prune', 'remove machine-index entries whose container no longer exists')
    .action(handle('doctor', { table: formatDoctor }, deps));

  withGlobals(program.command('brief'))
    .description('Print the handoff for an agent working in a lane')
    .argument('[lane]', 'lane name (default: the lane you are in)')
    .action(handle('brief', { table: formatBrief, args: ['lane'] }, deps));

  withGlobals(program.command('create'))
    .description('Create a lane: an isolated clone with its own ports, env file and lane files')
    .argument('[name]', 'lane name (default: the next free <lanePrefix><N>)')
    .option('--branch <name>', 'branch to check out (default: the container default branch)')
    .option('--dry-run', 'show what would be created without cloning or reserving anything')
    .action(handle('create', { table: formatCreate, args: ['name'] }, deps));

  withGlobals(program.command('refresh'))
    .description("Rewrite a lane's local files and .laines.env, then run post-create again (recovers a setup-failed lane)")
    .argument('[lane]', 'lane name (default: the lane you are in)')
    .option('--dry-run', 'show which hooks would run without changing anything')
    .action(handle('refresh', { table: formatRefresh, args: ['lane'] }, deps));

  withGlobals(program.command('report'))
    .description("Update a lane's board entry")
    .argument('[lane]', 'lane name (default: the lane you are in)')
    .option('--status <text>', 'lane status, e.g. idle, in-progress, review')
    .option('--task <text>', 'current task ("-" clears it)')
    .option('--blocked <text>', 'what the lane is blocked on ("-" clears it)')
    .option('--note <text>', 'a line for the Activity Log')
    .action(handle('report', { table: formatReport, args: ['lane'] }, deps));

  withGlobals(program.command('keep'))
    .description('Pin a lane so it cannot be torn down until a human releases it')
    .argument('[lane]', 'lane name (default: the lane you are in)')
    .option('--reason <text>', 'what depends on this lane, e.g. "base of stacked PR #123"')
    .action(handle('keep', { table: formatKeep, args: ['lane'] }, deps));

  withGlobals(program.command('release'))
    .description('Unpin a kept lane (human-only)')
    .argument('<lane>', 'lane name')
    .action(handle('release', { table: formatRelease, args: ['lane'] }, deps));

  withGlobals(program.command('list'))
    .description('List lanes')
    .option('--all', 'include closed lanes')
    .action(handle('list', { table: formatList }, deps));

  withGlobals(program.command('status'))
    .description('Show the container overview, or one lane')
    .argument('[lane]', 'lane name (default: the lane you are in, else the overview)')
    .action(handle('status', { table: formatStatus, args: ['lane'] }, deps));

  withGlobals(program.command('teardown'))
    .description('Close a lane: archive plans, delete context, and delete the clone unless --keep-dir (human-only)')
    .argument('<lane>', 'lane name')
    .option('--keep-dir', 'keep the clone instead of deleting it (skips the unpushed-work checks)')
    .option('--remove-dir', 'deprecated: deleting the clone is the default; accepted and ignored')
    .option('--force', 'remove even if the lane holds unpushed work (never overrides keep)')
    .option('--dry-run', 'show what would happen without changing anything')
    .action(handle('teardown', { table: formatTeardown, args: ['lane'] }, deps));

  // The group itself takes no options: `laines hooks --format json approve` must stay a usage error
  // so it cannot slip past the `Bash(laines hooks approve:*)` deny rule.
  const hooks = program.command('hooks').description('Review, approve and set the policy for lane hooks');
  withGlobals(hooks.command('status'))
    .description('List hooks as approved, changed or new, with diffs against the approved copies')
    .action(handle('hooks status', { table: formatHooksStatus }, deps));
  withGlobals(hooks.command('approve'))
    .description('Approve the current hooks (human-only)')
    .option('--lock', 'also set hook policy "approve", so later changes are refused until approved')
    .option('--dry-run', 'show what would be approved without changing anything')
    .action(handle('hooks approve', { table: formatHooksApprove }, deps));
  withGlobals(hooks.command('policy'))
    .description('Set the hook policy: approve, notify or open (human-only)')
    .argument('<policy>', 'approve | notify | open')
    .option('--dry-run', 'show the change without writing it')
    .action(handle('hooks policy', { table: formatHooksPolicy, args: ['policy'] }, deps));

  // Like `hooks`, the group takes no options of its own.
  const ai = program.command('ai').description("Share the container's .ai/ with lanes");
  withGlobals(ai.command('sync'))
    .description("Sync the container's .ai/ with a lane's committed .ai/ (three-way; conflicts stop it)")
    .argument('[lane]', 'lane name (default: the lane you are in)')
    .option('--dry-run', 'show what would move without changing anything')
    .action(handle('ai sync', { table: formatAiSync, args: ['lane'] }, deps));

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

  return program;
}

export async function run(argv, deps = defaultDeps) {
  // A bare `--` makes commander dispatch the next operand as a subcommand, which would slip
  // `laines hooks -- approve` past prefix-matched deny rules like `Bash(laines hooks approve:*)`.
  if (argv.slice(2).includes('--')) {
    process.stderr.write('laines does not accept a bare "--" argument.\n');
    process.exitCode = EXIT_CODES.CONFIG;
    return;
  }
  const program = buildProgram(deps);
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err && typeof err.code === 'string' && err.code.startsWith('commander.')) {
      process.exitCode = err.exitCode === 0 ? 0 : EXIT_CODES.CONFIG;
      return;
    }
    throw err;
  }
}
