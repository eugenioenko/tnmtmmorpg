import type { MovementComponent, NPCComponent, StatsComponent } from './types/components.ts';

/** Runtime shape check — component blobs come from JSON, so never trust them. */
export function isNPCComponent(value: unknown): value is NPCComponent {
  if (typeof value !== 'object' || value === null) return false;
  const npc = value as Record<string, unknown>;
  return (
    typeof npc.ai === 'string' &&
    typeof npc.state === 'string' &&
    typeof npc.lastActionTick === 'number'
  );
}

/** Runtime shape check — component blobs come from JSON, so never trust them. */
export function isMovementComponent(value: unknown): value is MovementComponent {
  if (typeof value !== 'object' || value === null) return false;
  const movement = value as Record<string, unknown>;
  return typeof movement.speed === 'number' && typeof movement.nextMoveTick === 'number';
}

/** Runtime shape check — component blobs come from JSON, so never trust them. */
export function isStatsComponent(value: unknown): value is StatsComponent {
  if (typeof value !== 'object' || value === null) return false;
  const stats = value as Record<string, unknown>;
  return (
    typeof stats.hp === 'number' &&
    typeof stats.maxHp === 'number' &&
    typeof stats.atk === 'number' &&
    typeof stats.def === 'number' &&
    typeof stats.level === 'number'
  );
}
