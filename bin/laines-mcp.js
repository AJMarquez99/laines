#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { defaultDeps } from '../src/deps.js';
import { createServer, parseServerArgs } from '../src/mcp/server.js';

// stdout carries the MCP protocol: anything else that prints goes to stderr.
for (const k of ['log', 'info', 'debug', 'table', 'dir']) console[k] = console.error;

try {
  const { container } = parseServerArgs(process.argv);
  await createServer(defaultDeps, { container }).connect(new StdioServerTransport());
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = err.exitCode ?? 1;
}
