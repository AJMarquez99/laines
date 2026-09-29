import { BlockedError, InvalidInputError } from './errors.js';

// Clear of common dev ports (3000/5000/8000) and of OS ephemeral ranges (32768+ Linux, 49152+ macOS).
export const DEFAULT_MACHINE = { range: [20000, 29999], blockSize: 200 };

export function allocateBlock({ range, blockSize }, takenBlocks) {
  for (let start = range[0]; start + blockSize - 1 <= range[1]; start += blockSize) {
    const end = start + blockSize - 1;
    if (!takenBlocks.some(([a, b]) => a <= end && start <= b)) return [start, end];
  }
  throw new BlockedError(
    `No free port block of ${blockSize} in ${range[0]}–${range[1]}.\n` +
      'Run `laines doctor --prune` to free blocks held by deleted containers, or widen machine.range in containers.json.',
  );
}

export function lanePorts(block, n, stride) {
  const start = block[0] + (n - 1) * stride;
  const end = start + stride - 1;
  if (!Number.isInteger(n) || n < 1 || end > block[1]) {
    throw new InvalidInputError(`Lane ${n} does not fit in port block ${block[0]}–${block[1]} with stride ${stride}.`);
  }
  return [start, end];
}
