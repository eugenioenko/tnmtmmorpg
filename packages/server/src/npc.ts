import { chunkKey, worldToChunk, type World } from './world.ts';

/**
 * NPC lifecycle: spawning helpers for the core 'npc' entity kind.
 *
 * An NPC is an ordinary entity with three extra components:
 *  - `npc`       — the brain: which AI behavior ('wander' is the core
 *                  built-in; features register their own namespaced AIs),
 *                  current state, and the spawn-chunk leash anchor.
 *  - `movement`  — best-effort stepping: one tile every `1/speed` ticks
 *                  (0.2 tiles/tick = one tile every 5 ticks).
 *  - `stats`     — combat stats (Phase 7): damageable, and chasing NPCs
 *                  fight back. The client draws a health bar from these.
 *
 * All three components persist like every other entity blob, so NPCs
 * survive restarts; the core NPC system (systems/npc-ai.ts) runs them with
 * spatial sleeping — NPCs in chunks with no players nearby cost zero CPU
 * per tick.
 */

/** The core NPC entity kind. */
export const NPC_KIND = 'npc';

/** Default wander speed in tiles per tick: one tile every 5 ticks. */
export const NPC_SPEED = 0.2;

/**
 * Spawn one NPC at (x, y) with the given behavior. `kind` is usually
 * NPC_KIND ('npc'); features may pass their own kind to give NPCs a
 * distinct sprite while reusing the core AI system. Returns the entity id.
 */
export function spawnNPC(world: World, kind: string, x: number, y: number, ai: string): number {
  const { cx, cy } = worldToChunk(x, y);
  return world.spawn(kind, { x, y }, {
    npc: {
      ai,
      state: 'idle',
      lastActionTick: 0,
      spawnChunk: chunkKey(cx, cy),
    },
    movement: {
      speed: NPC_SPEED,
      nextMoveTick: 0,
    },
    // Phase 7: combat stats — NPCs take damage and fight back when chased.
    stats: { hp: 30, maxHp: 30, atk: 8, def: 2, level: 1 },
  });
}

/**
 * Scatter `count` wandering NPCs on random walkable tiles inside the spawn
 * box near the origin (players spawn there, so the world reads alive from
 * the first moment). Seeded via world.rng(), so a given world seed always
 * scatters the same population. Returns how many actually spawned (a tiny
 * world may leave fewer room).
 */
export function scatterNPCs(world: World, count: number, area: number = 20): number {
  let span = area;
  if (world.width - 2 < span) span = world.width - 2;
  if (world.height - 2 < span) span = world.height - 2;
  if (span < 1) span = 1;

  let spawned = 0;
  for (let i = 0; i < count; i++) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const x = 1 + ~~(world.rng() * span);
      const y = 1 + ~~(world.rng() * span);
      if (!world.isWalkable(x, y)) continue;
      const occupied = world.all().some((e) => e.x === x && e.y === y);
      if (occupied) continue;
      spawnNPC(world, NPC_KIND, x, y, 'wander');
      spawned++;
      break;
    }
  }
  return spawned;
}
