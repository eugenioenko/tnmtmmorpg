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
 * - two listeners for other features' abilities:
 *                 'combat:strike' { attackerId, targetId, power?, bonus?,
 *                 range?, pierce?, element? } — a hit scaled from the
 *                 attacker's attack, optionally at range or through armour;
 *                 'combat:modifier' { entityId, taken, ticks } — for a
 *                 while, damage taken is multiplied by `taken` (0.5 for a
 *                 shield, 1.3 for a mark).
 * - three events: 'entity:damage' and 'entity:death', both announced
 *                 spatially (only entities near the victim hear them), so
 *                 other features hook loot, graves or aggro without
 *                 importing anything from here; and 'combat:killed', emitted
 *                 once globally with the victim's last state, because a
 *                 spatial event is delivered once per bystander and the
 *                 victim is gone by the time listeners run.
 *
 * Players are never despawned: their entity belongs to a live connection.
 * A player at 0 hp stays put until another feature (character) revives
 * them; with that feature absent they are restored to full on the spot.
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

/** Minimum ticks between two player swings; NPC swings are paced by their AI. */
const PLAYER_SWING_TICKS = 7;

/** Payload of 'combat:killed'. */
export interface KilledEvent {
  victimId: number;
  killerId: number;
  kind: string;
  x: number;
  y: number;
  world: string;
  components: Record<string, unknown>;
}

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
export interface StrikeOptions {
  /** Multiplier on the attacker's attack. */
  power?: number;
  /** Flat damage added after the multiplier. */
  bonus?: number;
  /** Reach in tiles (Chebyshev); melee is 1. */
  range?: number;
  /** Fraction of the target's defense ignored, 0..1. */
  pierce?: number;
  element?: string;
}

/** Damage-taken multipliers with an expiry tick, per entity. */
const modifiers = new Map<number, { taken: number; until: number }[]>();

function takenMultiplier(id: number): number {
  const list = modifiers.get(id);
  if (!list) return 1;
  let m = 1;
  for (const mod of list) if (mod.until > swingClock) m *= mod.taken;
  return m;
}

export function applyAttack(
  world: WorldAPI,
  attackerId: number,
  targetId: number,
  options: StrikeOptions = {},
): void {
  const attacker = world.get(attackerId);
  const target = world.get(targetId);
  if (!attacker || !target) return;

  const aStats = attacker.components.stats;
  const tStats = target.components.stats;
  if (!isStatsComponent(aStats) || !isStatsComponent(tStats)) return;

  // Reach gate: within `range` tiles (Chebyshev distance; 1 = adjacent), same world.
  const range = options.range ?? 1;
  if (abs(attacker.x - target.x) > range || abs(attacker.y - target.y) > range) return;
  if ((attacker.world ?? 'overworld') !== (target.world ?? 'overworld')) return;
  if (tStats.hp <= 0 || aStats.hp <= 0) return;

  const rawDamage = floor(aStats.atk * (options.power ?? 1) + (options.bonus ?? 0));
  const armour = tStats.def * 0.5 * (1 - (options.pierce ?? 0));
  const finalDamage = max(1, floor((rawDamage - armour) * takenMultiplier(targetId)));
  const hp = max(0, tStats.hp - finalDamage);

  // get() handed us a detached copy: build the new component and write it
  // back through the sanctioned update(), which marks the entity dirty.
  world.update(targetId, { stats: { ...tStats, hp } });

  // Spatial announce: only entities within DAMAGE_EVENT_RADIUS of the hit
  // hear it; each nearby entity receives the payload plus its own id.
  world.emitNear(
    target.x,
    target.y,
    DAMAGE_EVENT_RADIUS,
    'entity:damage',
    {
      targetId,
      sourceId: attackerId,
      amount: finalDamage,
      rawAmount: rawDamage,
      element: options.element ?? 'physical',
    } satisfies DamageEvent,
    target.world,
  );

  if (hp <= 0) {
    // Spatial too: only entities within DEATH_EVENT_RADIUS need to know
    // something died. The victim is despawned right after, so it is not
    // among the receivers when the event flushes.
    world.emitNear(
      target.x,
      target.y,
      DEATH_EVENT_RADIUS,
      'entity:death',
      { entityId: targetId, killerId: attackerId } satisfies DeathEvent,
      target.world,
    );
    world.emit('combat:killed', {
      victimId: targetId,
      killerId: attackerId,
      kind: target.kind,
      x: target.x,
      y: target.y,
      world: target.world ?? 'overworld',
      components: { ...target.components, stats: { ...tStats, hp: 0 } },
    } satisfies KilledEvent);
    if (target.kind !== 'player') world.despawn(targetId);
  }
}

/** Read a `targetId` out of a command/event payload, or undefined. */
function readId(args: unknown, key: string): number | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/** Feature-local swing pacing; a tick counter of our own, as core's is not exposed. */
let swingClock = 0;
const lastSwing = new Map<number, number>();

export default definePlugin({
  id: 'combat',
  items: [],
  recipes: [],
  entityKinds: [],
  systems: [
    {
      name: 'combat:clock',
      fn: (world) => {
        swingClock++;
        if (swingClock % 600 === 0) {
          for (const id of lastSwing.keys()) if (!world.get(id)) lastSwing.delete(id);
        }
        if (swingClock % 50 === 0) {
          for (const [id, list] of modifiers) {
            const live = list.filter((m) => m.until > swingClock);
            if (live.length === 0 || !world.get(id)) modifiers.delete(id);
            else modifiers.set(id, live);
          }
        }
        // Without a reviver installed, a felled player gets back up at once.
        if (swingClock % 20 === 0) {
          for (const p of world.query('player', 'stats')) {
            const stats = p.components.stats;
            if (isStatsComponent(stats) && stats.hp <= 0 && p.components.character === undefined) {
              world.update(p.id, { stats: { ...stats, hp: stats.maxHp } });
            }
          }
        }
      },
    },
  ],

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
        const now = swingClock;
        const last = lastSwing.get(entityId) ?? -Infinity;
        if (now - last < PLAYER_SWING_TICKS) return;
        lastSwing.set(entityId, now);
        applyAttack(world, entityId, targetId);
      },
    },
  ],

  events: {
    'combat:strike': (world, payload) => {
      const attackerId = readId(payload, 'attackerId');
      const targetId = readId(payload, 'targetId');
      if (attackerId === undefined || targetId === undefined) return;
      const p = payload as Record<string, unknown>;
      const num = (key: string): number | undefined => (typeof p[key] === 'number' ? (p[key] as number) : undefined);
      applyAttack(world, attackerId, targetId, {
        power: num('power'),
        bonus: num('bonus'),
        range: num('range'),
        pierce: num('pierce'),
        element: typeof p.element === 'string' ? p.element : undefined,
      });
    },
    'combat:modifier': (_world, payload) => {
      const entityId = readId(payload, 'entityId');
      const p = payload as { taken?: unknown; ticks?: unknown };
      if (entityId === undefined || typeof p.taken !== 'number' || typeof p.ticks !== 'number') return;
      if (p.taken <= 0 || p.ticks <= 0) return;
      const list = (modifiers.get(entityId) ?? []).filter((m) => m.until > swingClock);
      list.push({ taken: p.taken, until: swingClock + p.ticks });
      modifiers.set(entityId, list);
    },
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
