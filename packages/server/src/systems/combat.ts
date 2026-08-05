import { isStatsComponent, type DamageEvent, type DeathEvent, type SystemDef } from '@game/shared';
import type { EventBus } from '../events.ts';
import type { World } from '../world.ts';

/**
 * The core combat system (Phase 7).
 *
 * Attacks are applied synchronously by handleAttack — the tick loop's
 * 'attack' intent handler (player attacks) and the NPC system's chase logic
 * (NPC attacks) both call it. Damage and death are announced spatially on
 * the event bus (queued, delivered after systems run, only to entities
 * within radius of the victim): core logs deaths and feature listeners
 * react via plugin.events.
 *
 * The per-tick system (createCombatSystem) is the hook point for tick-driven
 * combat features — regeneration, DoT ticks, buff expiration — which is why
 * it is registered in runSystems before feature systems. Nothing per tick
 * yet: Phase 7 combat is purely event-driven.
 */

/** The World + event bus an attack needs: live entities to mutate, events to announce. */
export interface CombatContext {
  world: World;
  bus: EventBus;
}

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
 *  - damage = max(1, atk - def * 0.5), applied to the target's live stats;
 *  - an 'entity:damage' event announces the hit to entities within
 *    DAMAGE_EVENT_RADIUS of the target;
 *  - at hp <= 0 an 'entity:death' event fires (within DEATH_EVENT_RADIUS)
 *    and the target despawns.
 */
export function handleAttack(ctx: CombatContext, attackerId: number, targetId: number): void {
  const { world, bus } = ctx;
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

  tStats.hp -= finalDamage;
  world.markDirty(targetId);

  // Spatial announce: only entities within DAMAGE_EVENT_RADIUS of the hit
  // hear it; each nearby entity receives the payload plus its own id.
  bus.emitNear(target.x, target.y, DAMAGE_EVENT_RADIUS, 'entity:damage', {
    targetId,
    sourceId: attackerId,
    amount: finalDamage,
    rawAmount: rawDamage,
    element: 'physical',
  } satisfies DamageEvent);

  if (tStats.hp <= 0) {
    tStats.hp = 0;
    // Spatial too: only entities within DEATH_EVENT_RADIUS need to know
    // something died. The victim is despawned right after, so it is not
    // among the receivers when the event flushes.
    bus.emitNear(target.x, target.y, DEATH_EVENT_RADIUS, 'entity:death', {
      entityId: targetId,
      killerId: attackerId,
    } satisfies DeathEvent);
    world.despawn(targetId);
  }
}

/**
 * The per-tick combat system. Empty today — attacks are handled
 * synchronously by handleAttack; regeneration, DoT ticks and buff
 * expiration land here in later phases.
 */
export function createCombatSystem(): SystemDef {
  return {
    name: 'core:combat',
    // The world/delta args are deliberately ignored for now (lint bans
    // unused params, so take none; fewer params is assignable to the
    // SystemDef signature).
    fn: () => {
      // Nothing per tick yet — regen/DoTs/buffs land here later.
    },
  };
}
