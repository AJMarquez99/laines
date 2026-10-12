import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Single source of truth: the published package.json version.
const require = createRequire(import.meta.url);
export const VERSION = require('../package.json').version;

// What is installed right now: re-read from disk, since a long-running process keeps the VERSION it loaded.
export function installedVersion() {
  return JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version;
}

export function staleMessage(running, installed) {
  return `this laines-mcp is running ${running}, but ${installed} is installed: reconnect laines in your MCP client (for example /mcp in Claude Code)`;
}
