import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { VERSION } from '../src/version.js';

const root = new URL('..', import.meta.url).pathname;
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
    expect(pkg.engines.node).toBe('>=22.12.0');
  });

  it('exports nothing but package.json', () => {
    expect(pkg.exports).toEqual({ './package.json': './package.json' });
    const probe = "for (const s of ['@ajmarquez99/laines', '@ajmarquez99/laines/src/cli.js']) await import(s).then(() => console.log('ok'), (e) => console.log(e.code));";
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: root, encoding: 'utf8' });
    expect(out.trim().split('\n')).toEqual(['ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_PACKAGE_PATH_NOT_EXPORTED']);
  });

  it('single-sources the version', () => {
    expect(VERSION).toBe(pkg.version);
  });

  it('bin is executable and prints the version', () => {
    expect(statSync(bin).mode & 0o111).not.toBe(0);
    expect(execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim()).toBe(pkg.version);
  });
});

// npm only warns about `engines`, so each bin checks the Node version itself before importing anything.
describe('Node-version guard', () => {
  const bins = { laines: bin, 'laines-mcp': new URL('../bin/laines-mcp.js', import.meta.url).pathname };
  // Pretend to be another Node version: the preload runs before the bin's first line.
  const as = (version, file, args = []) =>
    spawnSync(process.execPath, ['--import', `data:text/javascript,Object.defineProperty(process.versions,'node',{value:'${version}'})`, file, ...args], {
      encoding: 'utf8',
      input: '',
      timeout: 10000,
    });

  for (const [name, file] of Object.entries(bins)) {
    it(`${name} refuses Node older than the engines floor`, () => {
      for (const version of ['18.20.0', '20.20.0', '22.11.9']) {
        const r = as(version, file);
        expect(r.status).toBe(2);
        expect(r.stdout).toBe('');
        expect(r.stderr).toBe(`${name} needs Node.js 22.12.0 or later (this is ${version}).\n`);
      }
    });

    it(`${name} imports nothing before the guard`, () => {
      const src = readFileSync(file, 'utf8');
      expect(src).not.toMatch(/^\s*import\s/m);
      expect(src.indexOf('process.versions.node')).toBeLessThan(src.indexOf('import('));
    });
  }

  it('lets the floor version through', () => {
    const r = as('22.12.0', bin, ['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(pkg.version);
  });
});
