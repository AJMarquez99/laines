import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readJson, writeJson } from './jsonfile.js';
import { parseWith } from './schema.js';
import { withLock } from './lock.js';
import { uniqueId, validateId } from './ids.js';
import { allocateBlock, DEFAULT_MACHINE } from './ports.js';
import { InvalidInputError } from './errors.js';

const Range = z.tuple([z.number().int(), z.number().int()]);

const IndexSchema = z.strictObject({
  version: z.literal(1),
  machine: z.strictObject({ range: Range, blockSize: z.number().int().positive() }),
  containers: z.array(
    z.strictObject({ id: z.string(), path: z.string(), portRange: Range, created: z.string() }),
  ),
});

export const indexFiles = (dir) => ({ file: join(dir, 'containers.json'), lock: join(dir, '.lock') });

export const emptyIndex = () => ({
  version: 1,
  machine: { range: [...DEFAULT_MACHINE.range], blockSize: DEFAULT_MACHINE.blockSize },
  containers: [],
});

export function loadIndex(dir) {
  const { file } = indexFiles(dir);
  return parseWith(IndexSchema, readJson(file, { onMissing: emptyIndex }), file);
}

export async function claimContainer(dir, { path, id, baseId, blockSize, now }) {
  const { file, lock } = indexFiles(dir);
  return withLock(lock, async () => {
    const index = loadIndex(dir);
    if (index.containers.some((c) => c.path === path)) {
      throw new InvalidInputError(`${path} is already registered as a L.AI.nes container.`);
    }
    const taken = index.containers.map((c) => c.id);
    let chosen;
    if (id !== undefined) {
      validateId(id);
      if (taken.includes(id)) throw new InvalidInputError(`Container id "${id}" is already used on this machine. Pick another with --id.`);
      chosen = id;
    } else {
      chosen = uniqueId(baseId, taken);
    }
    const size = blockSize ?? index.machine.blockSize;
    const portRange = allocateBlock({ range: index.machine.range, blockSize: size }, index.containers.map((c) => c.portRange));
    const entry = { id: chosen, path, portRange, created: now };
    index.containers.push(entry);
    writeJson(file, index);
    return entry;
  });
}

export async function releaseContainer(dir, id) {
  const { file, lock } = indexFiles(dir);
  await withLock(lock, async () => {
    const index = loadIndex(dir);
    index.containers = index.containers.filter((c) => c.id !== id);
    writeJson(file, index);
  });
}

export async function pruneIndex(dir) {
  const { file, lock } = indexFiles(dir);
  return withLock(lock, async () => {
    const index = loadIndex(dir);
    const alive = (c) => existsSync(join(c.path, '.laines', 'container.json'));
    const removed = index.containers.filter((c) => !alive(c));
    if (removed.length) {
      index.containers = index.containers.filter(alive);
      writeJson(file, index);
    }
    return removed;
  });
}
