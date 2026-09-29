import { laneFrom, loadContainer } from '../lib/container.js';
import { getLane, readLanes } from '../lib/lanes-store.js';
import { buildBrief } from '../lib/brief.js';
import { InvalidInputError } from '../lib/errors.js';

export async function runBrief(opts, deps) {
  const ctx = loadContainer(opts, deps);
  const name = laneFrom(opts, deps);
  const lane = getLane(readLanes(ctx), name);
  if (!lane) throw new InvalidInputError(`No lane named ${name}. See \`laines list\`.`);
  if (lane.state === 'closed') throw new InvalidInputError(`Lane ${name} is closed.`);
  return buildBrief(ctx, name, lane);
}
