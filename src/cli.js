import { Command } from 'commander';
import { defaultDeps } from './deps.js';
import { VERSION } from './version.js';
import { runInit } from './commands/init.js';
import { runConfigGet } from './commands/config.js';
import { runDoctor } from './commands/doctor.js';
import { EXIT_CODES, InvalidInputError, LainesError } from './lib/errors.js';
import { printJson, formatInit, formatConfig, formatDoctor } from './lib/format.js';

// The single choke point: positionals → opts, global options, rendering, error → exit code.
function handle(fn, { table, args } = {}, deps) {
  return async (...actionArgs) => {
    const cmd = actionArgs[actionArgs.length - 1];
    const positionals = actionArgs.slice(0, -2);
    const opts = { ...cmd.opts() };
    (args || []).forEach((name, i) => {
      if (positionals[i] !== undefined) opts[name] = positionals[i];
    });
    let root = cmd;
    while (root.parent) root = root.parent;
    const g = root.opts();
    if (opts.container === undefined) opts.container = g.container;
    try {
      if (!['json', 'table'].includes(g.format)) throw new InvalidInputError(`--format must be json or table (got "${g.format}").`);
      const result = await fn(opts, deps);
      if (g.format === 'table' && table) process.stdout.write(table(result) + '\n');
      else printJson(result);
    } catch (err) {
      process.stderr.write(((err && err.message) || String(err)) + '\n');
      process.exitCode = err instanceof LainesError ? err.exitCode : EXIT_CODES.GENERIC;
    }
  };
}

export function buildProgram(deps = defaultDeps) {
  const program = new Command();
  // exitOverride is inherited by subcommands created after this call.
  program.exitOverride();
  program
    .name('laines')
    .description('L.AI.nes: isolated parallel work lanes for coding agents')
    .version(VERSION)
    .option('--format <format>', 'output format: json|table', 'json')
    .option('--container <dir>', 'container directory (default: current directory)');

  program
    .command('init')
    .description('Create a new L.AI.nes container (shared .ai/ layer, board, lane tooling)')
    .argument('<dir>', 'directory to create the container in')
    .option('--remote <url>', 'git URL every lane clones')
    .option('--id <id>', 'machine-unique container id (default: from the repo name)')
    .option('--agents <list>', 'agents to wire: claude,codex,gemini', 'claude')
    .option('--branch <name>', 'default branch for new lanes', 'main')
    .option('--dry-run', 'show what would be created without writing anything')
    .action(handle(runInit, { table: formatInit, args: ['dir'] }, deps));

  const config = program.command('config').description('Read container settings');
  config
    .command('get')
    .description('Print the container config, or one dotted key')
    .argument('[key]', 'dotted key, e.g. hooks.policy')
    .action(handle(runConfigGet, { table: formatConfig, args: ['key'] }, deps));

  program
    .command('doctor')
    .description('Check the container, its .ai/ layer, agent wiring and the machine index')
    .option('--prune', 'remove machine-index entries whose container no longer exists')
    .action(handle(runDoctor, { table: formatDoctor }, deps));

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
