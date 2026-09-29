import { createRequire } from 'node:module';

// Single source of truth: the published package.json version.
const require = createRequire(import.meta.url);
export const VERSION = require('../package.json').version;
