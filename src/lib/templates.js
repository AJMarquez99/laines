import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEMPLATES_DIR = fileURLToPath(new URL('../../templates/', import.meta.url));

export const readTemplate = (name) => readFileSync(join(TEMPLATES_DIR, name), 'utf8');

// Unknown variables are a programming error: fail loudly instead of shipping "{{x}}".
export function renderTemplate(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (_m, key) => {
    if (!(key in vars)) throw new Error(`Template variable "${key}" has no value`);
    return String(vars[key]);
  });
}
