import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasMcpEntry, mcpServerEntry, mergeMcpConfig } from '../src/lib/mcp-config.js';
import { runCreate } from '../src/commands/create.js';
import { MalformedConfigError } from '../src/lib/errors.js';
import { tmp, cleanupTmp, setupContainer, gitIn } from './helpers.js';

afterEach(cleanupTmp);

describe('mergeMcpConfig', () => {
  it('adds the laines server and keeps the project\'s own servers', () => {
    const dir = tmp();
    const file = join(dir, '.mcp.json');
    writeFileSync(file, JSON.stringify({ mcpServers: { db: { command: 'db-mcp' } } }));
    expect(mergeMcpConfig(file, '/c')).toBe('written');
    expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers).toEqual({ db: { command: 'db-mcp' }, laines: mcpServerEntry('/c') });
    expect(mergeMcpConfig(file, '/c')).toBe('unchanged');
    expect(hasMcpEntry(file, '/c')).toBe(true);
    expect(hasMcpEntry(file, '/other')).toBe(false);
    expect(hasMcpEntry(join(dir, 'missing.json'), '/c')).toBe(false);
  });

  it('recognises an entry written by `claude mcp add` or customised by hand, and leaves it alone', () => {
    const file = join(tmp(), '.mcp.json');
    const custom = { type: 'stdio', command: 'laines-mcp', args: ['--container', '/c'], env: { DEBUG: '1' } };
    writeFileSync(file, JSON.stringify({ mcpServers: { laines: custom } }));
    expect(hasMcpEntry(file, '/c')).toBe(true);
    expect(mergeMcpConfig(file, '/c')).toBe('unchanged');
    expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers.laines).toEqual(custom);
  });

  it('refuses a file that is not an MCP config object', () => {
    const file = join(tmp(), '.mcp.json');
    writeFileSync(file, JSON.stringify({ mcpServers: [] }));
    expect(() => mergeMcpConfig(file, '/c')).toThrow(MalformedConfigError);
  });
});

describe('MCP wiring', () => {
  it('init registers the server for the container, and create for each lane, hidden from git', async () => {
    const s = await setupContainer();
    expect(hasMcpEntry(join(s.container, '.mcp.json'), s.container)).toBe(true);
    const lane = await runCreate({ container: s.container }, s.deps);
    expect(hasMcpEntry(join(lane.path, '.mcp.json'), s.container)).toBe(true);
    expect(lane.files).toContain('.mcp.json');
    expect(gitIn(lane.path, 'status', '--porcelain')).toBe('');
  });

  it('never overwrites a .mcp.json the repository tracks', async () => {
    const s = await setupContainer({ files: { 'README.md': '# app\n', '.mcp.json': '{"mcpServers":{"repo":{"command":"x"}}}\n' } });
    const lane = await runCreate({ container: s.container }, s.deps);
    expect(readFileSync(join(lane.path, '.mcp.json'), 'utf8')).toBe('{"mcpServers":{"repo":{"command":"x"}}}\n');
    expect(lane.warnings).toContain('.mcp.json not written: tracked by the repository');
  });

  it('skips the wiring when Claude is not a configured agent', async () => {
    const s = await setupContainer({ agents: 'codex' });
    expect(hasMcpEntry(join(s.container, '.mcp.json'), s.container)).toBe(false);
  });
});
