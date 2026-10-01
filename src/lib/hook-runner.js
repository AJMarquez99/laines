import { spawn } from 'node:child_process';

const MAX_OUTPUT = 64 * 1024;
const KILL_GRACE_MS = 5000;
// After the hook exits, how long to wait for its output pipes to close. A process it left running
// in the background (a dev server) may hold them open indefinitely.
const EXIT_GRACE_MS = 1000;
const REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_NAMESPACE'];
const FORWARDED = ['SIGINT', 'SIGTERM'];

// Runs one hook file. Never rejects: every outcome comes back as data.
// The hook leads its own process group, so a timeout or an interrupt stops everything it started.
// While it runs, SIGINT/SIGTERM sent to laines are passed on to that group instead of killing
// laines, so the caller still records the outcome.
export function runHookFile({ file, cwd, vars, timeoutMs, signals = process }) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...vars };
    for (const key of REPO_ENV) delete env[key];
    const started = Date.now();
    let output = '';
    let timedOut = false;
    let settled = false;
    let hardKill;
    let linger;
    let child;
    let interruptCount = 0;

    const append = (chunk) => {
      output += chunk;
      if (output.length > MAX_OUTPUT * 2) output = output.slice(-MAX_OUTPUT);
    };
    const killGroup = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {}
    };
    const stop = () => {
      if (!hardKill) {
        killGroup('SIGTERM');
        hardKill = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
      }
    };
    const forward = () => {
      interruptCount++;
      if (interruptCount === 1) {
        stop();
      } else {
        killGroup('SIGKILL');
      }
    };
    const finish = (status, signal, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKill) hardKill.unref();
      clearTimeout(linger);
      for (const s of FORWARDED) signals.off(s, forward);
      const text = output.length > MAX_OUTPUT ? `… (output truncated)\n${output.slice(-MAX_OUTPUT)}` : output;
      resolve({ status, signal, timedOut, output: text, error, durationMs: Date.now() - started });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);

    try {
      child = spawn(file, [], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish(null, null, error);
      return;
    }
    for (const s of FORWARDED) signals.on(s, forward);
    child.stdout.setEncoding('utf8').on('data', append);
    child.stderr.setEncoding('utf8').on('data', append);
    child.on('error', (error) => finish(null, null, error));
    child.on('exit', (status, signal) => {
      if (settled) return;
      linger = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(status, signal);
      }, EXIT_GRACE_MS);
    });
    child.on('close', (status, signal) => finish(status, signal));
  });
}
