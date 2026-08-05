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

  const entity = world.get(entityId);
  if (!entity) return; // despawned before the queue was drained

  const delta = DELTA[dir];
  const target = { x: entity.x + delta.x, y: entity.y + delta.y };
  if (!world.isWalkable(target.x, target.y)) return; // wall: authoritative rejection, silently

  // Move in place; the world keeps the spatial index and dirty set in sync.
  world.moveEntity(entityId, target.x, target.y);
}
