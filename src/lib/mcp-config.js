import { readJson, writeJson } from './jsonfile.js';
import { MalformedConfigError } from './errors.js';

export const MCP_SERVER_NAME = 'laines';

export const mcpServerEntry = (root) => ({ command: 'laines-mcp', args: ['--container', root] });

export const mcpAddCommand = (root) => `claude mcp add --scope project laines -- laines-mcp --container ${root}`;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Any entry that runs laines-mcp for this container counts, so one written by `claude mcp add`
// ("type": "stdio") or customised by a human (extra "env") is recognised and left alone.
function servesContainer(entry, root) {
  if (!isObject(entry) || entry.command !== 'laines-mcp' || !Array.isArray(entry.args)) return false;
  const i = entry.args.indexOf('--container');
  return i !== -1 && entry.args[i + 1] === root;
}

// Adds the laines entry if none serves this container; a project's own MCP servers are kept.
export function mergeMcpConfig(file, root) {
  const data = readJson(file, { onMissing: () => ({}) });
  if (!isObject(data)) throw new MalformedConfigError(file, 'expected a JSON object');
  if (data.mcpServers !== undefined && !isObject(data.mcpServers)) throw new MalformedConfigError(file, '"mcpServers" must be an object');
  const servers = data.mcpServers ?? {};
  if (Object.hasOwn(servers, MCP_SERVER_NAME) && servesContainer(servers[MCP_SERVER_NAME], root)) return 'unchanged';
  writeJson(file, { ...data, mcpServers: { ...servers, [MCP_SERVER_NAME]: mcpServerEntry(root) } });
  return 'written';
}

export function hasMcpEntry(file, root) {
  try {
    const servers = readJson(file, { onMissing: () => ({}) })?.mcpServers;
    return isObject(servers) && Object.hasOwn(servers, MCP_SERVER_NAME) && servesContainer(servers[MCP_SERVER_NAME], root);
  } catch {
    return false;
  }
}
