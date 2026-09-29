export function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

export function formatInit(r) {
  const lines = [
    r.dryRun ? 'dry run: nothing written' : `container ${r.id} created`,
    `id:      ${r.id}`,
    `path:    ${r.path}`,
    `ports:   ${r.portRange[0]}–${r.portRange[1]}`,
    `repo:    ${r.repo.remote} (${r.repo.defaultBranch})`,
    `agents:  ${r.agents.join(', ')}`,
  ];
  if (r.next.length) lines.push('', 'next:', ...r.next.map((s) => `  ${s}`));
  return lines.join('\n');
}

export function formatConfig(r) {
  if (r && Object.prototype.hasOwnProperty.call(r, 'key') && Object.keys(r).length === 2) {
    return `${r.key} = ${typeof r.value === 'object' ? JSON.stringify(r.value) : r.value}`;
  }
  return JSON.stringify(r, null, 2);
}

export function formatDoctor(r) {
  const lines = [];
  if (r.container) lines.push(`container: ${r.container.id ?? '(unknown)'} at ${r.container.path}`);
  for (const c of r.checks) lines.push(`${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  if (r.pruned) lines.push(`pruned: ${r.pruned.length ? r.pruned.map((p) => `${p.id} (${p.path})`).join(', ') : 'nothing'}`);
  lines.push(r.ok ? 'status: ok' : 'status: problems found');
  return lines.join('\n');
}

export const formatBrief = (r) => r.text;

export function formatCreate(r) {
  const head = [
    r.dryRun ? `dry run: would create ${r.lane} (${r.id})` : `lane ${r.lane} created`,
    `path:    ${r.path}`,
    `branch:  ${r.branch}`,
    `ports:   ${r.ports[0]}–${r.ports[1]}`,
  ];
  if (r.dryRun) return [...head, `remote:  ${r.remote}`].join('\n');
  const lines = [...head, ...r.warnings.map((w) => `warning: ${w}`), '', r.brief.text, 'next:', ...r.next.map((s) => `  ${s}`)];
  return lines.join('\n');
}
