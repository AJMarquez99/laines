import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readTemplate, renderTemplate } from '../src/lib/templates.js';
import {
  LANES_BEGIN, LANES_END, upsertBlock, denyRules, mergeDenyRules, addIndexRow, appendOnce, HUMAN_ONLY_COMMANDS,
} from '../src/lib/agent-files.js';
import { InvalidInputError, MalformedConfigError } from '../src/lib/errors.js';
import { tmp, cleanupTmp } from './helpers.js';

afterEach(cleanupTmp);

describe('templates', () => {
  it('renders variables and rejects unknown ones', () => {
    expect(renderTemplate('a {{x}} b', { x: 1 })).toBe('a 1 b');
    expect(() => renderTemplate('{{nope}}', {})).toThrow('nope');
  });

  it('ships every template, each rendering with its documented variables', () => {
    const vars = { containerId: 'app', lane: 'lane_1', containerDir: '/c' };
    for (const name of ['lanes-block.md', 'lane-management.md', 'lane-ai-readme.md', 'lane-context-readme.md', 'lane-plans-readme.md', 'hooks-readme.md', 'context-board-note.md']) {
      expect(renderTemplate(readTemplate(name), vars).length).toBeGreaterThan(50);
    }
  });
});

describe('upsertBlock', () => {
  it('appends after existing content, then replaces in place idempotently', () => {
    const f = join(tmp(), 'CLAUDE.md');
    writeFileSync(f, '<!-- BEGIN .ai-convention -->\nx\n<!-- END .ai-convention -->\n');
    expect(upsertBlock(f, 'v1')).toBe('written');
    let txt = readFileSync(f, 'utf8');
    expect(txt.indexOf(LANES_BEGIN)).toBeGreaterThan(txt.indexOf('<!-- END .ai-convention -->'));
    expect(upsertBlock(f, 'v1')).toBe('unchanged');
    upsertBlock(f, 'v2');
    txt = readFileSync(f, 'utf8');
    expect(txt).toContain(`${LANES_BEGIN}\nv2\n${LANES_END}`);
    expect(txt).not.toContain('v1');
    expect(txt.match(new RegExp(LANES_BEGIN, 'g'))).toHaveLength(1);
  });

  it('creates a missing file and refuses a half-open block', () => {
    const d = tmp();
    expect(upsertBlock(join(d, 'AGENTS.md'), 'b')).toBe('written');
    writeFileSync(join(d, 'GEMINI.md'), `${LANES_BEGIN}\nno end\n`);
    expect(() => upsertBlock(join(d, 'GEMINI.md'), 'b')).toThrow(InvalidInputError);
  });
});

describe('deny rules', () => {
  it('covers every human-only command for each invocation form', () => {
    const rules = denyRules();
    for (const c of HUMAN_ONLY_COMMANDS) {
      expect(rules).toContain(`Bash(laines ${c}:*)`);
      expect(rules).toContain(`Bash(npx @ajmarquez99/laines ${c}:*)`);
    }
  });

  it('merges into existing settings without dropping user rules, and is idempotent', () => {
    const d = tmp();
    const f = join(d, '.claude', 'settings.json');
    mkdirSync(join(d, '.claude'));
    writeFileSync(f, JSON.stringify({ model: 'x', permissions: { deny: ['Bash(rm:*)'], allow: ['Read'] } }));
    expect(mergeDenyRules(f, ['Bash(laines release:*)']).added).toEqual(['Bash(laines release:*)']);
    const s = JSON.parse(readFileSync(f, 'utf8'));
    expect(s.model).toBe('x');
    expect(s.permissions.allow).toEqual(['Read']);
    expect(s.permissions.deny).toEqual(['Bash(rm:*)', 'Bash(laines release:*)']);
    expect(mergeDenyRules(f, ['Bash(laines release:*)']).added).toEqual([]);
  });

  it('refuses to overwrite an invalid settings file', () => {
    const d = tmp();
    const f = join(d, 'settings.json');
    writeFileSync(f, '{ broken');
    expect(() => mergeDenyRules(f, ['x'])).toThrow(MalformedConfigError);
    expect(readFileSync(f, 'utf8')).toBe('{ broken');
  });
});

describe('index rows and one-time sections', () => {
  it('adds an index row once', () => {
    const f = join(tmp(), 'README.md');
    writeFileSync(f, '## Index\n\n| File | Answers |\n|---|---|\n');
    expect(addIndexRow(f, 'a.md', 'What A answers')).toBe('written');
    expect(addIndexRow(f, 'a.md', 'What A answers')).toBe('unchanged');
    expect(readFileSync(f, 'utf8')).toBe('## Index\n\n| File | Answers |\n|---|---|\n| [a.md](a.md) | What A answers |\n');
    expect(addIndexRow(join(tmp(), 'nope.md'), 'a.md', 'x')).toBe('missing');
  });

  it('appends a keyed section once', () => {
    const f = join(tmp(), 'README.md');
    writeFileSync(f, 'head\n');
    appendOnce(f, 'board-note', 'note');
    appendOnce(f, 'board-note', 'note');
    expect(readFileSync(f, 'utf8')).toBe('head\n\n<!-- laines:board-note -->\nnote\n');
  });
});
