import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Metadata only. A failed audit write warns and never fails the action it records.
export function appendAudit(file, entry, { warn = () => {} } = {}) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(entry) + '\n');
    return true;
  } catch (err) {
    warn(`audit log write failed (${file}): ${err.message}`);
    return false;
  }
}
