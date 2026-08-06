import { MAX_MOVE_DIST } from '@game/shared';
import type { Direction, MoveIntent, WorldCoord } from '@game/shared';
import type { World } from '../world.ts';

const DIRECTIONS: readonly Direction[] = ['n', 's', 'e', 'w'];

const DELTA: Record<Direction, WorldCoord> = {
  n: { x: 0, y: -1 },
  s: { x: 0, y: 1 },
  e: { x: 1, y: 0 },
  w: { x: -1, y: 0 },
};

function isDirection(value: unknown): value is Direction {
  return typeof value === 'string' && (DIRECTIONS as readonly string[]).includes(value);
}

/**
 * Apply a 'move' intent: validate the direction, then move the entity one
 * tile in that direction when walkable.
 */
export function handleMoveIntent(world: World, entityId: number, intent: MoveIntent): void {
  // The entity is bound to the connection; a client-supplied id is forgery.
  if ('id' in intent) {
    console.warn(`[tick] entity ${entityId} tried to move a target entity — rejected`);
    return;
  }
  const dir = intent.dir;
  if (typeof dir !== 'string' || !isDirection(dir)) {
    console.warn(`[tick] entity ${entityId} sent invalid move dir '${String(dir)}' — rejected`);
    return;
  }

  // Optional stride (exploration aid). Anything not a positive integer is
  // forgery or a client bug; clamp rather than trust, and cap the cost of a
  // single intent at MAX_MOVE_DIST steps.
  const raw = intent.dist;
  let dist = 1;
  if (raw !== undefined) {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
      console.warn(`[tick] entity ${entityId} sent invalid move dist '${String(raw)}' — rejected`);
      return;
    }
    dist = raw > MAX_MOVE_DIST ? MAX_MOVE_DIST : raw;
  }

  const entity = world.get(entityId);
  if (!entity) return; // despawned before the queue was drained

  const delta = DELTA[dir];
  // A stride jumps over whatever is in between — that is the point of it for
  // exploration, since walking would just stop at the first lake. Only the
  // landing tile is validated: scan back toward the origin for the nearest
  // walkable tile so a jump never leaves an entity standing inside water or
  // a mountain. dist === 1 reduces to the ordinary single-tile move.
  for (let step = dist; step >= 1; step--) {
    const nx = entity.x + delta.x * step;
    const ny = entity.y + delta.y * step;
    // Walkability in the entity's OWN world: a floor tile inside a building
    // and a lake in the overworld can share coordinates.
    if (!world.isWalkable(nx, ny, entity.world)) continue;
    // Move in place; coords wrap around the torus world automatically.
    world.moveEntity(entityId, nx, ny);
    return;
  }
  // Every candidate tile was blocked: authoritative rejection, silently.
}
