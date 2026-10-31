#!/usr/bin/env node
// Node-version guard. It runs before any import, so this file must parse on old Node: keep it ES2022.
var v = process.versions.node.split('.').map(Number); if (v[0] < 22 || (v[0] === 22 && v[1] < 12)) { process.stderr.write('laines-mcp needs Node.js 22.12.0 or later (this is ' + process.versions.node + ').\n'); process.exit(2); }

// stdout carries the MCP protocol: anything else that prints goes to stderr.
for (const k of ['log', 'info', 'debug', 'table', 'dir']) console[k] = console.error;

const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
const { defaultDeps } = await import('../src/deps.js');
const { createServer, parseServerArgs } = await import('../src/mcp/server.js');

try {
  const { container } = parseServerArgs(process.argv);
  await createServer(defaultDeps, { container }).connect(new StdioServerTransport());
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = err.exitCode ?? 1;
}
