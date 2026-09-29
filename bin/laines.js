#!/usr/bin/env node
import { run } from '../src/cli.js';

run(process.argv).catch((err) => {
  process.stderr.write(((err && (err.stack || err.message)) || String(err)) + '\n');
  process.exitCode = 1;
});
