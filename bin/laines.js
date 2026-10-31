#!/usr/bin/env node
// Node-version guard. It runs before any import, so this file must parse on old Node: keep it ES2022.
var v = process.versions.node.split('.').map(Number); if (v[0] < 22 || (v[0] === 22 && v[1] < 12)) { process.stderr.write('laines needs Node.js 22.12.0 or later (this is ' + process.versions.node + ').\n'); process.exit(1); }

const { run } = await import('../src/cli.js');

run(process.argv).catch((err) => {
  process.stderr.write(((err && (err.stack || err.message)) || String(err)) + '\n');
  process.exitCode = 1;
});
