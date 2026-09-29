import { Command } from 'commander';
import { VERSION } from './version.js';

export function buildProgram() {
  const program = new Command();
  program
    .name('laines')
    .description('L.AI.nes: isolated parallel work lanes for coding agents')
    .version(VERSION)
    .option('--format <format>', 'output format: json|table', 'json');
  return program;
}

export async function run(argv) {
  await buildProgram().parseAsync(argv);
}
