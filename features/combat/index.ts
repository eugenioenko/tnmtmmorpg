import {
  definePlugin,
  isStatsComponent,
  type DamageEvent,
  type DeathEvent,
  type WorldAPI,
} from '@game/shared';

/**
 * The combat feature — melee damage and death, entirely outside core.
 *
 * - one command:  'combat:attack' ({ targetId }) — a player swings at an
 *                 adjacent entity. The client sends it like any other
 *                 intent; the command registry dispatches on the kind.
 * - one listener: 'npc:attack' — core's NPC system announces that a chasing
 *                 NPC swung at its target. Core does not know what a swing
 *                 does; this feature decides. With the feature disabled,
 *                 NPC swings are simply inert.
 * - two events:   'entity:damage' and 'entity:death', both announced
 *                 spatially (only entities near the victim hear them), so
 *                 other features hook loot, graves or aggro without
 *                 importing anything from here.
 *
 * Everything runs on the sanctioned WorldAPI: get() for a detached read,
 * update() to write the new stats back, despawn() on death.
 */

/**
 * Only entities within this many tiles (Chebyshev) of a hit receive its
 * 'entity:damage' event — a fight at (5000, 5000) never wakes the
 * population at (0, 0).
 */
const DAMAGE_EVENT_RADIUS = 20;

/** Only entities within this many tiles of a death receive 'entity:death'. */
const DEATH_EVENT_RADIUS = 30;

// The project bans the Math global (lint), so the formula's helpers are
// hand-rolled. `n | 0` is floor for the small magnitudes used here.
const abs = (n: number): number => (n < 0 ? -n : n);
const max = (a: number, b: number): number => (a > b ? a : b);
const floor = (n: number): number => n | 0;

/**
 * Apply one melee hit from `attackerId` onto `targetId`:
 *  - both must exist and carry a stats component (no stats = untargetable);
 *  - the attacker must be within 1 tile (Chebyshev), like transfers and
 *    station crafts;
 *  - damage = max(1, atk - def * 0.5), written back with world.update;
 *  - an 'entity:damage' event announces the hit to entities within
 *    DAMAGE_EVENT_RADIUS of the target;
 *  - at hp <= 0 an 'entity:death' event fires (within DEATH_EVENT_RADIUS)
 *    and the target despawns.
 *
 * Exported so the verification scripts can drive it directly; features talk
 * to combat through the command and the events, never by importing this.
 */
export function applyAttack(world: WorldAPI, attackerId: number, targetId: number): void {
  const attacker = world.get(attackerId);
  const target = world.get(targetId);
  if (!attacker || !target) return;

  const aStats = attacker.components.stats;
  const tStats = target.components.stats;
  if (!isStatsComponent(aStats) || !isStatsComponent(tStats)) return;

  // Adjacency gate: must be within 1 tile (Chebyshev distance).
  if (abs(attacker.x - target.x) > 1 || abs(attacker.y - target.y) > 1) return;

  const rawDamage = aStats.atk;
  const finalDamage = max(1, floor(rawDamage - tStats.def * 0.5));
  const hp = max(0, tStats.hp - finalDamage);

  // get() handed us a detached copy: build the new component and write it
  // back through the sanctioned update(), which marks the entity dirty.
  world.update(targetId, { stats: { ...tStats, hp } });

  // Spatial announce: only entities within DAMAGE_EVENT_RADIUS of the hit
  // hear it; each nearby entity receives the payload plus its own id.
  world.emitNear(target.x, target.y, DAMAGE_EVENT_RADIUS, 'entity:damage', {
    targetId,
    sourceId: attackerId,
    amount: finalDamage,
    rawAmount: rawDamage,
    element: 'physical',
  } satisfies DamageEvent);

  if (hp <= 0) {
    // Spatial too: only entities within DEATH_EVENT_RADIUS need to know
    // something died. The victim is despawned right after, so it is not
    // among the receivers when the event flushes.
    world.emitNear(target.x, target.y, DEATH_EVENT_RADIUS, 'entity:death', {
      entityId: targetId,
      killerId: attackerId,
    } satisfies DeathEvent);
    world.despawn(targetId);
  }
}

/** Read a `targetId` out of a command/event payload, or undefined. */
function readId(args: unknown, key: string): number | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

export default definePlugin({
  id: 'combat',
  items: [],
  recipes: [],
  entityKinds: [],
  systems: [],

  commands: [
    {
      // The player attack. `targetId` is client-supplied but harmless:
      // applyAttack gates on stats and adjacency, so a forged id hits
      // nothing it shouldn't.
      name: 'combat:attack',
      fn: (world, args, entityId) => {
        const targetId = readId(args, 'targetId');
        if (targetId === undefined) {
          world.log(`entity ${entityId} attack: targetId must be an integer - rejected`);
          return;
        }
        applyAttack(world, entityId, targetId);
      },
    },
  ],

  events: {
    /**
     * A chasing NPC swung at its target. Core's NPC system decides WHEN an
     * NPC swings (that is AI, and it re-checks adjacency itself); what a
     * swing does is combat's business, so it lands here. The payload carries
     * the attacker and target ids; applyAttack re-validates both.
     */
    'npc:attack': (world, payload) => {
      const attackerId = readId(payload, 'attackerId');
      const targetId = readId(payload, 'targetId');
      if (attackerId === undefined || targetId === undefined) return;
      applyAttack(world, attackerId, targetId);
    },
  },
});
