import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readJson, writeJson } from './jsonfile.js';
import { InvalidInputError, MalformedConfigError } from './errors.js';

export const AGENT_FLAGS = { claude: '--claude', codex: '--codex', gemini: '--gemini' };
export const AGENT_FILES = { claude: 'CLAUDE.md', codex: 'AGENTS.md', gemini: 'GEMINI.md' };

export const LANES_BEGIN = '<!-- BEGIN laines-lanes -->';
export const LANES_END = '<!-- END laines-lanes -->';

// Appended at the end of the file, so it always follows dot-ai's convention block, which
// `dot-ai sync` rewrites in place without touching anything after its END marker.
export function upsertBlock(file, body) {
  const block = `${LANES_BEGIN}\n${body.replace(/\n+$/, '')}\n${LANES_END}`;
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const b = cur.indexOf(LANES_BEGIN);
  const e = cur.indexOf(LANES_END);
  let next;
  if (b !== -1 && e > b) {
    next = cur.slice(0, b) + block + cur.slice(e + LANES_END.length);
  } else if (b !== -1 || e !== -1) {
    throw new InvalidInputError(`${file} has an incomplete laines-lanes block (one marker without the other). Fix or remove the markers and retry.`);
  } else {
    next = (cur ? cur.replace(/\n*$/, '\n\n') : '') + block + '\n';
  }
  if (next === cur) return 'unchanged';
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
  return 'written';
}

export const HUMAN_ONLY_COMMANDS = ['teardown', 'release', 'hooks approve', 'hooks policy', 'config set'];
const INVOCATIONS = ['laines', 'npx laines', 'npx @ajmarquez99/laines'];

export const denyRules = () => HUMAN_ONLY_COMMANDS.flatMap((c) => INVOCATIONS.map((i) => `Bash(${i} ${c}:*)`));

export function mergeDenyRules(file, rules) {
  const data = readJson(file, { onMissing: () => ({}) });
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new MalformedConfigError(file, 'expected a JSON object');
  }
  const permissions = data.permissions && typeof data.permissions === 'object' ? data.permissions : {};
  const deny = Array.isArray(permissions.deny) ? permissions.deny : [];
  const added = rules.filter((r) => !deny.includes(r));
  if (added.length) writeJson(file, { ...data, permissions: { ...permissions, deny: [...deny, ...added] } });
  return { added };
}

// dot-ai folder READMEs end with the `## Index` table, so a row can be appended at the end.
export function addIndexRow(readme, file, answers) {
  if (!existsSync(readme)) return 'missing';
  const cur = readFileSync(readme, 'utf8');
  if (cur.includes(`](${file})`)) return 'unchanged';
  writeFileSync(readme, `${cur.replace(/\n*$/, '\n')}| [${file}](${file}) | ${answers} |\n`);
  return 'written';
}

export function appendOnce(file, key, text) {
  const marker = `<!-- laines:${key} -->`;
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (cur.includes(marker)) return 'unchanged';
  writeFileSync(file, `${cur.replace(/\n*$/, '\n')}\n${marker}\n${text.replace(/\n+$/, '')}\n`);
  return 'written';
}
