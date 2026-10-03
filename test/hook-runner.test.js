import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runHookFile } from '../src/lib/hook-runner.js';
import { tmp, cleanupTmp } from './helpers.js';

afterEach(cleanupTmp);

function script(dir, body, name = 'hook') {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

describe('runHookFile', () => {
  it('runs in cwd with the given variables and captures stdout and stderr', async () => {
    const dir = tmp();
    const file = script(dir, 'echo "out $LANE_NAME $(pwd -P)"; echo err >&2');
    const r = await runHookFile({ file, cwd: dir, vars: { LANE_NAME: 'lane_1' }, timeoutMs: 5000 });
    expect(r).toMatchObject({ status: 0, signal: null, timedOut: false, error: null });
    expect(r.output).toContain(`out lane_1 ${dir}`);
    expect(r.output).toContain('err');
  });

  it('returns the exit status', async () => {
    const dir = tmp();
    expect((await runHookFile({ file: script(dir, 'exit 3'), cwd: dir, vars: {}, timeoutMs: 5000 })).status).toBe(3);
  });

  it('keeps PATH but drops variables that would point git at another repository', async () => {
    const dir = tmp();
    const file = script(dir, 'command -v git >/dev/null && echo has-git; echo "gd=${GIT_DIR-unset}"');
    const r = await runHookFile({ file, cwd: dir, vars: { GIT_DIR: '/elsewhere' }, timeoutMs: 5000 });
    expect(r.output).toContain('has-git');
    expect(r.output).toContain('gd=unset');
  });

  it('gives the hook an empty stdin, so a prompt cannot hang it', async () => {
    const dir = tmp();
    const r = await runHookFile({ file: script(dir, 'read answer; echo "read=$?"'), cwd: dir, vars: {}, timeoutMs: 5000 });
    expect(r.output).toContain('read=1');
    expect(r.durationMs).toBeLessThan(2000);
  });

  it('stops the hook and everything it started when it times out', async () => {
    const dir = tmp();
    const file = script(dir, 'sleep 30 &\necho $! > child.pid\nwait');
    const r = await runHookFile({ file, cwd: dir, vars: {}, timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.status).toBe(null);
    const pid = Number(readFileSync(join(dir, 'child.pid'), 'utf8'));
    expect(await until(() => !alive(pid))).toBe(true);
  });

  it('returns once the hook exits, even if a background process keeps its output open', async () => {
    const dir = tmp();
    const started = Date.now();
    const r = await runHookFile({ file: script(dir, 'sleep 3 &\necho done'), cwd: dir, vars: {}, timeoutMs: 10000 });
    expect(r.status).toBe(0);
    expect(r.output).toContain('done');
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('keeps only the tail of very long output', async () => {
    const dir = tmp();
    const body = 'i=0; while [ $i -lt 3000 ]; do echo "line $i ................................................................"; i=$((i+1)); done';
    const r = await runHookFile({ file: script(dir, body), cwd: dir, vars: {}, timeoutMs: 10000 });
    expect(r.output.startsWith('… (output truncated)\n')).toBe(true);
    expect(r.output.length).toBeLessThanOrEqual(64 * 1024 + 30);
    expect(r.output).toContain('line 2999');
  });

  it('reports a file that cannot be run instead of throwing', async () => {
    const dir = tmp();
    const r = await runHookFile({ file: join(dir, 'missing'), cwd: dir, vars: {}, timeoutMs: 5000 });
    expect(r.status).toBe(null);
    expect(r.error).toBeInstanceOf(Error);
  });

  it('passes an interrupt on to the hook, then stops listening', async () => {
    const dir = tmp();
    const signals = new EventEmitter();
    const pending = runHookFile({ file: script(dir, 'sleep 30'), cwd: dir, vars: {}, timeoutMs: 20000, signals });
    await new Promise((r) => setTimeout(r, 200));
    signals.emit('SIGINT');
    const r = await pending;
    expect(r).toMatchObject({ signal: 'SIGTERM', timedOut: false, status: null });
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('timeout hard-kills a child that ignores SIGTERM', async () => {
    const dir = tmp();
    const file = script(dir, "sh -c 'trap \"\" TERM; sleep 30' &\necho $! > child.pid\nwait");
    const r = await runHookFile({ file, cwd: dir, vars: {}, timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.status).toBe(null);
    const pid = Number(readFileSync(join(dir, 'child.pid'), 'utf8'));
    expect(await until(() => !alive(pid), 8000)).toBe(true);
  }, 15000);

  it('a second interrupt escalates to SIGKILL', async () => {
    const dir = tmp();
    const signals = new EventEmitter();
    const ready = join(dir, 'ready');
    const pending = runHookFile({ file: script(dir, `trap '' TERM\ntouch "${ready}"\nsleep 30`), cwd: dir, vars: {}, timeoutMs: 20000, signals });
    expect(await until(() => existsSync(ready))).toBe(true);
    signals.emit('SIGINT');
    await new Promise((r) => setTimeout(r, 200));
    signals.emit('SIGINT');
    const r = await pending;
    expect(r.signal).toBe('SIGKILL');
    expect(r.durationMs).toBeLessThan(20000);
  });
});
