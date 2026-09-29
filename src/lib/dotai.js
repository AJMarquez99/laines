import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

// dot-ai has no programmatic API; run its CLI from our own dependency tree so the version is pinned
// by package.json, never whatever `dot-ai` happens to be on PATH.
export function dotAiBin() {
  const pkgPath = require.resolve('@ajmarquez99/dot-ai/package.json');
  const pkg = require(pkgPath);
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['dot-ai'];
  return join(dirname(pkgPath), bin);
}

// dot-ai works on process.cwd() only, logs to stderr, and signals success through its exit code.
export function runDotAi(args, { cwd }) {
  const r = spawnSync(process.execPath, [dotAiBin(), ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}
