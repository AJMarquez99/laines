import { runSummary } from './hook-events.js';
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

export function formatDryHooks(h) {
  const list = h.hooks.length ? h.hooks.map((x) => `${x.hook} (${x.state})`).join(', ') : 'none';
  return `hooks:   ${h.event}: ${list}${h.refused ? ' — would be refused (policy approve)' : ''}`;
}

export function formatRefresh(r) {
  if (r.dryRun) return [`dry run: would refresh ${r.lane}`, `path:    ${r.path}`, formatDryHooks(r.hooks)].join('\n');
  return [
    `lane ${r.lane} refreshed`,
    `path:    ${r.path}`,
    `branch:  ${r.branch}`,
    `hooks:   post-create: ${runSummary(r.hooks)}`,
    ...r.warnings.map((w) => `warning: ${w}`),
  ].join('\n');
}

export function formatCreate(r) {
  const head = [
    r.dryRun ? `dry run: would create ${r.lane} (${r.id})` : `lane ${r.lane} created`,
    `path:    ${r.path}`,
    `branch:  ${r.branch}`,
    `ports:   ${r.ports[0]}–${r.ports[1]}`,
  ];
  if (r.dryRun) return [...head, `remote:  ${r.remote}`, formatDryHooks(r.hooks)].join('\n');
  const lines = [...head, `hooks:   post-create: ${runSummary(r.hooks)}`, ...r.warnings.map((w) => `warning: ${w}`), '', r.brief.text, 'next:', ...r.next.map((s) => `  ${s}`)];
  return lines.join('\n');
}

export const formatReport = (r) => `${r.lane}: status=${r.status}, task=${r.task ?? '-'}, blocked=${r.blocked ?? '-'}`;
export const formatKeep = (r) => `${r.lane} kept: ${r.kept.reason}`;
export const formatRelease = (r) => (r.released ? `${r.lane} released` : `${r.lane} was not kept`);

export function formatList(r) {
  if (!r.lanes.length) return 'no lanes';
  return r.lanes
    .map((l) => [
      l.kept ? '📌' : '  ',
      l.lane.padEnd(14),
      l.state.padEnd(13),
      String(l.status).padEnd(14),
      l.branch.padEnd(28),
      `${l.ports[0]}–${l.ports[1]}`,
    ].join(' '))
    .join('\n');
}

export function formatStatus(r) {
  if (r.lanes) {
    const requests = r.requests.length ? r.requests.map((q) => `  ${q.text} → ${q.command}`).join('\n') : '  none';
    return [`container ${r.container.id} · ports ${r.container.portRange[0]}–${r.container.portRange[1]}`, formatList(r), 'requests:', requests].join('\n');
  }
  return [
    `${r.lane} (${r.id})`,
    `state:   ${r.state}`,
    `status:  ${r.status}`,
    `task:    ${r.task ?? '-'}`,
    `blocked: ${r.blocked ?? '-'}`,
    `branch:  ${r.branch}`,
    `ports:   ${r.ports[0]}–${r.ports[1]}`,
    `path:    ${r.path}`,
    `kept:    ${r.kept ? r.kept.reason : '-'}`,
  ].join('\n');
}

export function formatTeardown(r) {
  if (r.dryRun) {
    const lines = [`dry run: ${r.blocked ? 'teardown would be refused' : `would tear down ${r.lane}`}`];
    for (const p of r.checks?.problems ?? []) lines.push(`  - ${p}`);
    if (r.removedDir) lines.push(`would remove ${r.path}`);
    for (const h of r.hooks ?? []) lines.push(formatDryHooks(h));
    return lines.join('\n');
  }
  const lines = [`${r.lane} torn down`];
  lines.push(r.archivedTo ? `plans archived to ${r.archivedTo}` : 'no plans to archive');
  if (r.removedDir) lines.push(`removed ${r.path}${r.forced ? ' (forced)' : ''}`);
  else lines.push(`clone left at ${r.path}`);
  for (const h of r.hooks ?? []) lines.push(`hooks:   ${h.event}: ${runSummary(h)}`);
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  return lines.join('\n');
}

export function formatHooksStatus(r) {
  const lines = [`policy: ${r.policy}`];
  if (!r.hooks.length && !r.removed.length) lines.push('no hooks');
  for (const h of r.hooks) lines.push(`${h.state.padEnd(9)} ${h.hook}${h.executable ? '' : ' (not executable)'}`);
  for (const rel of r.removed) lines.push(`${'removed'.padEnd(9)} ${rel}`);
  if (r.lockSuggested) lines.push('', 'hooks are stable: a human can lock them with `laines hooks approve --lock`');
  for (const h of r.hooks.filter((x) => x.diff)) lines.push('', `--- ${h.hook} (${h.state}) ---`, h.diff.trimEnd());
  return lines.join('\n');
}

export function formatHooksApprove(r) {
  const diffs = (list, label) => list.filter((h) => h.diff).flatMap((h) => ['', `--- ${h.hook} (${label(h)}) ---`, h.diff.trimEnd()]);
  const dropped = r.removed.map((rel) => `  dropped ${rel} (no longer present)`);
  if (r.dryRun) {
    return [
      `dry run: would approve ${r.approve.length} hook(s)${r.lock ? ' and set hook policy approve' : ''}`,
      ...r.approve.map((h) => `  ${h.hook} (${h.state})`),
      ...dropped,
      ...diffs(r.approve, (h) => h.state),
    ].join('\n');
  }
  return [
    `approved ${r.approved.length} hook(s); hook policy ${r.policy}`,
    ...r.approved.map((h) => `  ${h.hook} ${h.checksum}${h.was === 'approved' ? '' : ` (was ${h.was})`}`),
    ...dropped,
    ...diffs(r.approved, (h) => h.was),
  ].join('\n');
}

export const formatHooksPolicy = (r) =>
  r.dryRun ? `dry run: hook policy ${r.from} → ${r.to}` : r.changed ? `hook policy ${r.from} → ${r.to}` : `hook policy already ${r.to}`;

export function formatConfigSet(r) {
  const change = `${r.key}: ${JSON.stringify(r.from)} → ${JSON.stringify(r.to)}`;
  if (r.dryRun) return `dry run: ${change}`;
  return r.changed ? change : `${r.key} is already ${JSON.stringify(r.to)}`;
}
