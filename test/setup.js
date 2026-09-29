import { tmpdir } from 'node:os';
import { join } from 'node:path';

// No user or system git config (signing, hooks, default remote names) leaks into any test.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
// Git still reads $XDG_CONFIG_HOME/git/ignore (else ~/.config/git/ignore) without any config
// file; point it at a directory that never exists so a personal ignore list cannot hide fixtures.
process.env.XDG_CONFIG_HOME = join(tmpdir(), 'laines-test-no-xdg-config');
