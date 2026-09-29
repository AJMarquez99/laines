import { Command } from 'commander';
import { defaultDeps } from './deps.js';
import { VERSION } from './version.js';
import { runInit } from './commands/init.js';
import { runConfigGet } from './commands/config.js';
import { runDoctor } from './commands/doctor.js';
import { runBrief } from './commands/brief.js';
import { runCreate } from './commands/create.js';
import { runReport, runKeep, runRelease, runList, runStatus } from './commands/lanes.js';
import { EXIT_CODES, InvalidInputError, LainesError } from './lib/errors.js';
import { printJson, formatInit, formatConfig, formatDoctor, formatBrief, formatCreate, formatReport, formatKeep, formatRelease, formatList, formatStatus } from './lib/format.js';

// The single choke point: positionals → opts, global options, rendering, error → exit code.
function handle(fn, { table, args } = {}, deps) {
  return async (...actionArgs) => {
    const cmd = actionArgs[actionArgs.length - 1];
    const positionals = actionArgs.slice(0, -2);
    const { format, ...opts } = cmd.opts();
    (args || []).forEach((name, i) => {
      if (positionals[i] !== undefined) opts[name] = positionals[i];
    });
    try {
      if (!['json', 'table'].includes(format)) throw new InvalidInputError(`--format must be json or table (got "${format}").`);
      const result = await fn(opts, deps);
      if (format === 'table' && table) process.stdout.write(table(result) + '\n');
      else printJson(result);
    } catch (err) {
      if (err instanceof LainesError) {
        process.stderr.write(err.message + '\n');
        process.exitCode = err.exitCode;
      } else {
        process.stderr.write(((err && (err.stack || err.message)) || String(err)) + '\n');
        process.exitCode = EXIT_CODES.GENERIC;
      }
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
    .option('--dry-run', 'show what would be created without writing anything')
    .action(handle(runInit, { table: formatInit, args: ['dir'] }, deps));

  const config = program.command('config').description('Read container settings');
  withGlobals(config.command('get'))
    .description('Print the container config, or one dotted key')
    .argument('[key]', 'dotted key, e.g. hooks.policy')
    .action(handle(runConfigGet, { table: formatConfig, args: ['key'] }, deps));

  withGlobals(program.command('doctor'))
    .description('Check the container, its .ai/ layer, agent wiring and the machine index')
    .option('--prune', 'remove machine-index entries whose container no longer exists')
    .action(handle(runDoctor, { table: formatDoctor }, deps));

  withGlobals(program.command('brief'))
    .description('Print the handoff for an agent working in a lane')
    .argument('[lane]', 'lane name (default: the lane you are in)')
    .action(handle(runBrief, { table: formatBrief, args: ['lane'] }, deps));

  withGlobals(program.command('create'))
    .description('Create a lane: an isolated clone with its own ports, env file and lane files')
    .argument('[name]', 'lane name (default: the next free <lanePrefix><N>)')
    .option('--branch <name>', 'branch to check out (default: the container default branch)')
    .option('--dry-run', 'show what would be created without cloning or reserving anything')
    .action(handle(runCreate, { table: formatCreate, args: ['name'] }, deps));

  withGlobals(program.command('report'))
    .description("Update a lane's board entry")
    .argument('[lane]', 'lane name (default: the lane you are in)')
    .option('--status <text>', 'lane status, e.g. idle, in-progress, review')
    .option('--task <text>', 'current task ("-" clears it)')
    .option('--blocked <text>', 'what the lane is blocked on ("-" clears it)')
    .option('--note <text>', 'a line for the Activity Log')
    .action(handle(runReport, { table: formatReport, args: ['lane'] }, deps));

  withGlobals(program.command('keep'))
    .description('Pin a lane so it cannot be torn down until a human releases it')
    .argument('[lane]', 'lane name (default: the lane you are in)')
    .option('--reason <text>', 'what depends on this lane, e.g. "base of stacked PR #123"')
    .action(handle(runKeep, { table: formatKeep, args: ['lane'] }, deps));

  withGlobals(program.command('release'))
    .description('Unpin a kept lane (human-only)')
    .argument('<lane>', 'lane name')
    .action(handle(runRelease, { table: formatRelease, args: ['lane'] }, deps));

  withGlobals(program.command('list'))
    .description('List lanes')
    .option('--all', 'include closed lanes')
    .action(handle(runList, { table: formatList }, deps));

  withGlobals(program.command('status'))
    .description('Show the container overview, or one lane')
    .argument('[lane]', 'lane name (default: the lane you are in, else the overview)')
    .action(handle(runStatus, { table: formatStatus, args: ['lane'] }, deps));

  return program;
}

export async function run(argv, deps = defaultDeps) {
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
