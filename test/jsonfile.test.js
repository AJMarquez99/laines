import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readJson, writeJson, getPath } from '../src/lib/jsonfile.js';
import { parseWith } from '../src/lib/schema.js';
import { MalformedConfigError } from '../src/lib/errors.js';
import { tmp, cleanupTmp } from './helpers.js';

afterEach(cleanupTmp);

describe('readJson', () => {
  it('returns onMissing() for a missing or blank file', () => {
    const d = tmp();
    expect(readJson(join(d, 'nope.json'))).toEqual({});
    writeFileSync(join(d, 'blank.json'), '  \n');
    expect(readJson(join(d, 'blank.json'), { onMissing: () => ({ a: 1 }) })).toEqual({ a: 1 });
  });

  it('throws MalformedConfigError for invalid JSON', () => {
    const d = tmp();
    writeFileSync(join(d, 'bad.json'), '{ nope');
    expect(() => readJson(join(d, 'bad.json'))).toThrow(MalformedConfigError);
  });
});

describe('writeJson', () => {
  it('creates parent dirs, pretty-prints with a trailing newline, leaves no temp files', () => {
    const d = tmp();
    const f = join(d, 'a', 'b', 'x.json');
    writeJson(f, { k: [1] });
    expect(readFileSync(f, 'utf8')).toBe('{\n  "k": [\n    1\n  ]\n}\n');
    expect(readdirSync(join(d, 'a', 'b'))).toEqual(['x.json']);
  });
});

describe('getPath', () => {
  it('reads dotted paths', () => {
    expect(getPath({ a: { b: 2 } }, 'a.b')).toBe(2);
    expect(getPath({ a: 1 }, 'a.b')).toBeUndefined();
  });
});

describe('parseWith', () => {
  it('returns parsed data or throws MalformedConfigError naming the field', () => {
    const s = z.strictObject({ n: z.number() });
    expect(parseWith(s, { n: 1 }, 'f.json')).toEqual({ n: 1 });
    try {
      parseWith(s, { n: 'x' }, 'f.json');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MalformedConfigError);
      expect(e.message).toContain('n:');
    }
  });
});
