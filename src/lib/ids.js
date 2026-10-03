import { InvalidInputError } from './errors.js';

// One lane-name rule for create and lane detection.
export const LANE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function slugify(s) {
  const slug = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return slug || 'container';
}

export function repoSlugFromRemote(remote) {
  const last = String(remote).replace(/\/+$/, '').split(/[/:]/).pop() || '';
  return slugify(last.replace(/\.git$/, ''));
}

export function uniqueId(base, takenIds) {
  const taken = new Set(takenIds);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function validateId(id) {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(id))) {
    throw new InvalidInputError(
      `Invalid container id "${id}": use lowercase letters, digits and hyphens, start with a letter or digit, max 32 characters.`,
    );
  }
  return id;
}

// Database/cache identifiers can't contain hyphens unquoted, so the suffix swaps them for underscores.
export const laneSuffix = (id, n) => `_${id.replace(/-/g, '_')}_l${n}`;
export const composeProject = (id, n) => `${id}-l${n}`;
export const laneId = (id, lane) => `${id}/${lane}`;
