import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { VERSION } from '../src/version.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const bin = new URL('../bin/laines.js', import.meta.url).pathname;

describe('package', () => {
  it('is ESM and declares the laines bin', () => {
    expect(pkg.type).toBe('module');
    expect(pkg.bin.laines).toBe('./bin/laines.js');
  });

  it('is publish-shaped', () => {
    expect(pkg.name).toBe('@ajmarquez99/laines');
    expect(pkg.files).toEqual(expect.arrayContaining(['bin/', 'src/', 'templates/', 'README.md', 'LICENSE']));
    expect(pkg.publishConfig).toEqual({ access: 'public' });
    expect(pkg.license).toBe('MIT');
    expect(pkg.engines.node).toBe('>=20');
  });

  it('single-sources the version', () => {
    expect(VERSION).toBe(pkg.version);
  });

  it('bin is executable and prints the version', () => {
    expect(statSync(bin).mode & 0o111).not.toBe(0);
    expect(execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim()).toBe(pkg.version);
  });
});
