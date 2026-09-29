import { homedir } from 'node:os';
import { runDotAi } from './lib/dotai.js';

// The only place real process state and external programs are wired in. Tests pass their own.
export const defaultDeps = {
  env: process.env,
  homedir: () => homedir(),
  cwd: () => process.cwd(),
  now: () => new Date().toISOString(),
  runDotAi: (args, opts) => runDotAi(args, opts),
  warn: (msg) => process.stderr.write(`warn: ${msg}\n`),
};
