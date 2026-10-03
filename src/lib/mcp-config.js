import { readJson, writeJson } from './jsonfile.js';
import { MalformedConfigError } from './errors.js';
import { shellQuote } from './paths.js';

export const MCP_SERVER_NAME = 'laines';

export const mcpServerEntry = (root) => ({ command: 'laines-mcp', args: ['--container', root] });

export const mcpAddCommand = (root) => `claude mcp add --scope project laines -- laines-mcp --container ${shellQuote(root)}`;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Any entry that runs laines-mcp for this container counts, so one written by `claude mcp add`
// ("type": "stdio") or customised by a human (extra "env") is recognised and left alone.
function servesContainer(entry, root) {
  if (!isObject(entry) || entry.command !== 'laines-mcp' || !Array.isArray(entry.args)) return false;
  const i = entry.args.indexOf('--container');
  return i !== -1 && entry.args[i + 1] === root;
}

// Adds the laines entry if none serves this container; a project's own MCP servers are kept.
function readMcpConfig(file) {
  const data = readJson(file, { onMissing: () => ({}) });
  if (!isObject(data)) throw new MalformedConfigError(file, 'expected a JSON object');
  if (data.mcpServers !== undefined && !isObject(data.mcpServers)) throw new MalformedConfigError(file, '"mcpServers" must be an object');
  return data;
}

export function mergeMcpConfig(file, root) {
  const data = readMcpConfig(file);
  const servers = data.mcpServers ?? {};
  if (Object.hasOwn(servers, MCP_SERVER_NAME) && servesContainer(servers[MCP_SERVER_NAME], root)) return 'unchanged';
  writeJson(file, { ...data, mcpServers: { ...servers, [MCP_SERVER_NAME]: mcpServerEntry(root) } });
  return 'written';
}

// False for a missing file or a missing/foreign entry; throws MalformedConfigError for a file that cannot be read as MCP config.
export function hasMcpEntry(file, root) {
  const servers = readMcpConfig(file).mcpServers;
  return servers !== undefined && Object.hasOwn(servers, MCP_SERVER_NAME) && servesContainer(servers[MCP_SERVER_NAME], root);
}
