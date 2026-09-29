// 0 ok · 1 unexpected/external · 2 user-fixable input or config · 3 blocked by a boundary / needs a human · 4 capability denied
export const EXIT_CODES = { OK: 0, GENERIC: 1, CONFIG: 2, BLOCKED: 3, CAPABILITY_DENIED: 4 };

export class LainesError extends Error {
  constructor(message, exitCode = EXIT_CODES.GENERIC) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}

export class InvalidInputError extends LainesError {
  constructor(message) {
    super(message, EXIT_CODES.CONFIG);
  }
}

export class MalformedConfigError extends LainesError {
  constructor(path, detail) {
    super(`Malformed file: ${path}${detail ? `\n  ${detail}` : ''}\nFix the file and retry.`, EXIT_CODES.CONFIG);
    this.path = path;
  }
}

export class NotAContainerError extends LainesError {
  constructor(dir) {
    super(
      `Not a L.AI.nes container: ${dir} (no .laines/container.json).\n` +
        'Run from the container directory, pass --container <dir>, or create one with `laines init`.',
      EXIT_CODES.CONFIG,
    );
    this.dir = dir;
  }
}

export class BlockedError extends LainesError {
  constructor(message) {
    super(message, EXIT_CODES.BLOCKED);
  }
}

export class LockTimeoutError extends LainesError {
  constructor(lockDir, timeoutMs) {
    super(
      `Could not acquire the lock ${lockDir} within ${Math.round(timeoutMs / 1000)}s.\n` +
        `If no other laines command is running, remove it: rmdir '${lockDir}'`,
      EXIT_CODES.GENERIC,
    );
    this.lockDir = lockDir;
  }
}
