import { homedir } from 'node:os';
import { runDotAi } from './lib/dotai.js';
import { runGit } from './lib/git.js';
import { busyPorts } from './lib/netports.js';

// The only place real process state and external programs are wired in. Tests pass their own.
export const defaultDeps = {
  env: process.env,
  homedir: () => homedir(),
  cwd: () => process.cwd(),
  now: () => new Date().toISOString(),
  runDotAi: (args, opts) => runDotAi(args, opts),
  git: (args, opts) => runGit(args, opts),
  busyPorts: (range) => busyPorts(range),
  warn: (msg) => process.stderr.write(`warn: ${msg}\n`),
};
