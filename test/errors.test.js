import { describe, it, expect } from 'vitest';
import {
  EXIT_CODES, LainesError, InvalidInputError, MalformedConfigError, NotAContainerError, BlockedError, LockTimeoutError,
} from '../src/lib/errors.js';

describe('errors', () => {
  it('maps each error to its exit code', () => {
    expect(new LainesError('x').exitCode).toBe(EXIT_CODES.GENERIC);
    expect(new InvalidInputError('x').exitCode).toBe(2);
    expect(new MalformedConfigError('/a.json', 'bad').exitCode).toBe(2);
    expect(new NotAContainerError('/c').exitCode).toBe(2);
    expect(new BlockedError('x').exitCode).toBe(3);
    expect(new LockTimeoutError('/l', 5000).exitCode).toBe(1);
  });

  it('carries useful fields and names', () => {
    const e = new MalformedConfigError('/a.json', 'Unexpected token');
    expect(e.name).toBe('MalformedConfigError');
    expect(e.path).toBe('/a.json');
    expect(e.message).toContain('/a.json');
    expect(e.message).toContain('Unexpected token');
    expect(new LockTimeoutError('/l', 5000).message).toContain("rmdir '/l'");
    expect(new NotAContainerError('/c').message).toContain('laines init');
    expect(e).toBeInstanceOf(LainesError);
  });
});
