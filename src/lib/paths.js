import { join } from 'node:path';

export function configDir(env, homedir) {
  if (env.LAINES_CONFIG_DIR) return env.LAINES_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'laines');
  return join(homedir, '.config', 'laines');
}

export function containerPaths(root) {
  const laines = join(root, '.laines');
  const ai = join(root, '.ai');
  return {
    root,
    laines,
    marker: join(laines, 'container.json'),
    config: join(laines, 'config.json'),
    lanes: join(laines, 'lanes.json'),
    hooks: join(laines, 'hooks'),
    hooksLock: join(laines, 'hooks.lock.json'),
    audit: join(laines, 'audit.jsonl'),
    lock: join(laines, '.lock'),
    ai,
    board: join(ai, 'context', 'LANES_BOARD.md'),
    runbook: join(ai, 'runbooks', 'lane-management.md'),
    templatesDir: join(ai, 'templates'),
    claudeSettings: join(root, '.claude', 'settings.json'),
  };
}

// POSIX single-quoting for paths shown in copy-paste hints.
export const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
