import type {
  AIDef,
  DamageEvent,
  Direction,
  EntityState,
  MovementComponent,
  NPCComponent,
  WorldAPI,
  WorldCoord,
} from '@game/shared';
import { isMovementComponent, isNPCComponent } from '@game/shared';
import { CHUNK_SIZE, worldToChunk, type Entity, type World } from '../world.ts';
import { findPath } from '../pathfinding.ts';
import { NPC_KIND } from '../npc.ts';
import { handleAttack, type CombatContext } from './combat.ts';

/**
 * The core NPC system (registered in server/src/index.ts, running before
 * feature systems every tick — it is core infrastructure, not a feature).
 *
 * What it does per tick:
 *  1. SPATIAL SLEEPING — the whole point. An NPC whose chunk neighborhood
 *     holds no player entity never runs its AI and never logs: zero CPU.
 *     A player approaching wakes it; a player leaving puts it back to
 *     sleep. Sleep/wake transitions are the only per-NPC log lines.
 *  2. AI DISPATCH — the NPC's `npc.ai` behavior runs. Feature-registered
 *     AIs (the `ais` plugin registry) run under the guard, exactly like
 *     feature systems: a broken AI disables itself, never the server.
 *     Unknown names fall back to the built-in 'wander'.
 *  3. MOVEMENT — the AI only decides; the system steps. When the tick
 *     reaches `movement.nextMoveTick` and a direction is set, one tile
 *     moves in that direction if walkable (walls block silently, and the
 *     NPC pauses a beat so a wall hit reads as a pause, not a buzz).
 *
 * The built-in 'wander' behavior: idle ↔ wandering with random pauses and
 * direction changes, staying within LEASH_CHUNKS chunks of the spawn
 * chunk, never walking through walls or off the world. It also implements
 * the chasing/fleeing states (step toward / away from `npc.target`) so
 * those states work out of the box for feature AIs that set a target.
 */

/** NPCs with a player within this many tiles are awake; everyone else sleeps. */
export const NPC_ACTIVATION_RADIUS = CHUNK_SIZE;

/** Awake NPCs receive this list of nearby entities to react to. */
export const NPC_NEARBY_RADIUS = 6;

/** Wander behaviors stay within this many chunks of the spawn chunk. */
const LEASH_CHUNKS = 2;

/** Per-tick chance an idle NPC starts wandering (expected ~2s idle). */
const IDLE_TO_WANDER_CHANCE = 0.05;

/** Per-tick chance a wandering NPC stops for a rest (expected ~2.5s walking). */
const WANDER_TO_IDLE_CHANCE = 0.04;

/** Chance a wandering NPC keeps its current direction when a move is due. */
const DIR_KEEP_CHANCE = 0.7;

/** Fallback move interval when a movement component has no sane speed. */
const DEFAULT_MOVE_INTERVAL = 5;

/** Chasing stops when the target is this close (Chebyshev). */
const CHASE_STOP_DISTANCE = 1;

/** A chasing NPC whose target is adjacent swings this many ticks apart (1s at 10Hz). */
const CHASE_ATTACK_INTERVAL = 10;

const DIRECTIONS: readonly Direction[] = ['n', 's', 'e', 'w'];

const DELTA: Record<Direction, WorldCoord> = {
  n: { x: 0, y: -1 },
  s: { x: 0, y: 1 },
  e: { x: 1, y: 0 },
  w: { x: -1, y: 0 },
};

function abs(value: number): number {
  return value < 0 ? -value : value;
}

export interface NPCAIEntry {
  feature: string;
  name: string;
  fn: AIDef['fn'];
}

export interface NPCSystemOptions {
  world: World;
  /** Feature-registered AIs by namespaced name; 'wander' is the core built-in. */
  ais: ReadonlyMap<string, NPCAIEntry>;
  /** Resolve the WorldAPI of the feature that registered an AI. */
  apiFor: (feature: string) => WorldAPI | undefined;
  /** Run feature AI code under the guard; returns false when skipped/disabled. */
  runGuarded: (feature: string, name: string, fn: () => void) => boolean;
  /** Phase 7: combat context for chase attacks (NPCs hit adjacent targets). */
  combat: CombatContext;
}

export interface NPCSystem {
  /** 'core:npc-ai' — surfaced in logs. */
  name: string;
  /** Run once per tick; `tick` is the loop's absolute tick number. */
  run: (deltaSeconds: number, tick: number) => void;
  /**
   * Phase 7 damage reaction: an NPC that takes a hit drops what it was doing
   * and chases the attacker. Registered on 'entity:damage' by server/index.ts
   * — core code, because it mutates the LIVE entity, which features never
   * see (their WorldAPI.get returns detached copies).
   */
  onDamage: (payload: unknown) => void;
}

/** Ticks between moves for a movement component's speed (0.2 -> 5). */
function moveInterval(speed: number): number {
  if (!(speed > 0)) return DEFAULT_MOVE_INTERVAL;
  const ticks = ~~(1 / speed + 0.5);
  return ticks < 1 ? 1 : ticks;
}

/** Detached snapshots of the entities within `radius` tiles (Chebyshev). */
function nearbyEntities(world: World, entity: Entity, radius: number): EntityState[] {
  const { cx, cy } = worldToChunk(entity.x, entity.y);
  return world
    .entitiesInView(cx, cy, radius, radius)
    .filter(
      (e) =>
        e.id !== entity.id && abs(e.x - entity.x) <= radius && abs(e.y - entity.y) <= radius,
    )
    .map((e) => ({ id: e.id, kind: e.kind, x: e.x, y: e.y, components: { ...e.components } }));
}

/** The compass direction from `entity` onto `step` (a pathfinding result). */
function directionTo(entity: Entity, step: WorldCoord): Direction {
  if (step.x > entity.x) return 'e';
  if (step.x < entity.x) return 'w';
  if (step.y > entity.y) return 's';
  return 'n';
}

/** The walkable step that moves furthest from the fleeing target. */
function fleeDirection(world: World, entity: Entity, target: Entity): Direction | undefined {
  let best: Direction | undefined;
  let bestDist = -1;
  for (const dir of DIRECTIONS) {
    const delta = DELTA[dir];
    const tx = entity.x + delta.x;
    const ty = entity.y + delta.y;
    if (!world.isWalkable(tx, ty)) continue;
    const dist = abs(tx - target.x) + abs(ty - target.y);
    if (dist > bestDist) {
      bestDist = dist;
      best = dir;
    }
  }
  return best;
}

/** True when (x, y) stays within LEASH_CHUNKS chunks of the NPC's spawn chunk. */
function withinLeash(npc: NPCComponent, x: number, y: number): boolean {
  const anchor = npc.spawnChunk;
  if (typeof anchor !== 'string' || anchor.length === 0) return true;
  const comma = anchor.indexOf(',');
  if (comma < 0) return true;
  const ax = Number(anchor.slice(0, comma));
  const ay = Number(anchor.slice(comma + 1));
  if (!Number.isFinite(ax) || !Number.isFinite(ay)) return true;
  const { cx, cy } = worldToChunk(x, y);
  return abs(cx - ax) <= LEASH_CHUNKS && abs(cy - ay) <= LEASH_CHUNKS;
}

/**
 * A random walkable direction that keeps the NPC on its leash, or undefined
 * when every candidate is a wall or off-leash (the NPC waits and tries
 * again next action).
 */
function pickWanderDir(world: World, entity: Entity, npc: NPCComponent): Direction | undefined {
  const order = [0, 1, 2, 3].sort(() => world.rng() - 0.5);
  for (const i of order) {
    const dir = DIRECTIONS[i];
    const delta = DELTA[dir];
    const tx = entity.x + delta.x;
    const ty = entity.y + delta.y;
    if (!world.isWalkable(tx, ty)) continue;
    if (!withinLeash(npc, tx, ty)) continue;
    return dir;
  }
  return undefined;
}

/**
 * The built-in behavior for `npc.ai === 'wander'` (and the fallback for
 * unknown names). Decides state and direction only — the core system
 * applies movement afterwards.
 */
function runBuiltinWander(world: World, entity: Entity, tick: number): void {
  const npc = entity.components.npc as NPCComponent;
  const movement = entity.components.movement as MovementComponent;

  // chasing: step toward the target along a bounded A* path.
  if (npc.state === 'chasing') {
    const target = typeof npc.target === 'number' ? world.get(npc.target) : undefined;
    if (target) {
      if (
        abs(target.x - entity.x) <= CHASE_STOP_DISTANCE &&
        abs(target.y - entity.y) <= CHASE_STOP_DISTANCE
      ) {
        movement.dir = undefined; // in reach: stand and face it
      } else {
        const path = findPath(world, entity.x, entity.y, target.x, target.y, 30);
        const step = path[1];
        movement.dir = step ? directionTo(entity, step) : undefined;
      }
      return;
    }
    npc.target = undefined;
    npc.state = 'wandering'; // target vanished: fall through to wander
  }

  // fleeing: step away from the target.
  if (npc.state === 'fleeing') {
    const target = typeof npc.target === 'number' ? world.get(npc.target) : undefined;
    if (target) {
      movement.dir = fleeDirection(world, entity, target);
      return;
    }
    npc.target = undefined;
    npc.state = 'wandering';
  }

  // idle: rest until the wander itch returns.
  if (npc.state === 'idle') {
    if (world.rng() < IDLE_TO_WANDER_CHANCE) npc.state = 'wandering';
    return;
  }

  // wandering (also the default for any unrecognized state).
  if (world.rng() < WANDER_TO_IDLE_CHANCE) {
    npc.state = 'idle';
    movement.dir = undefined;
    return;
  }
  const keep = movement.dir !== undefined && world.rng() < DIR_KEEP_CHANCE;
  if (!keep) {
    movement.dir = pickWanderDir(world, entity, npc);
  }
  npc.lastActionTick = tick;
}

/** Dispatch to the registered AI, or the built-in wander. */
function runAI(
  options: NPCSystemOptions,
  entity: Entity,
  nearby: EntityState[],
  tick: number,
  warnedAis: Set<string>,
): void {
  const npc = entity.components.npc as NPCComponent;
  const aiName = npc.ai;
  const entry = options.ais.get(aiName);
  if (entry) {
    const api = options.apiFor(entry.feature);
    if (!api) return;
    options.runGuarded(entry.feature, entry.name, () => entry.fn(api, entity, nearby, tick));
    return;
  }
  if (aiName !== 'wander' && !warnedAis.has(aiName)) {
    warnedAis.add(aiName);
    console.warn(
      `[npc] #${entity.id}: ai '${aiName}' is not registered - using built-in 'wander'`,
    );
  }
  runBuiltinWander(options.world, entity, tick);
}

/**
 * Step one tile in the requested direction when a move is due. The AI only
 * set `movement.dir`; this is where positions actually change, so the
 * spatial index and the dirty set stay in sync via world.moveEntity.
 */
function applyMovement(
  world: World,
  entity: Entity,
  npc: NPCComponent,
  movement: MovementComponent,
  tick: number,
): void {
  if (!movement.dir || tick < movement.nextMoveTick) return;
  const delta = DELTA[movement.dir];
  const tx = entity.x + delta.x;
  const ty = entity.y + delta.y;
  if (world.isWalkable(tx, ty)) {
    world.moveEntity(entity.id, tx, ty);
    npc.lastActionTick = tick;
    movement.nextMoveTick = tick + moveInterval(movement.speed);
  } else {
    // Blocked: drop the direction so the AI picks a fresh one, and wait a
    // beat so a wall hit reads as a pause, not a frantic buzz.
    movement.dir = undefined;
    movement.nextMoveTick = tick + moveInterval(movement.speed);
  }
}

export function createNPCSystem(options: NPCSystemOptions): NPCSystem {
  /** NPCs currently asleep; wakes/sleeps are logged once per transition. */
  const sleeping = new Set<number>();
  /** Unknown ai names already warned about (log each name once). */
  const warnedAis = new Set<string>();
  /** NPC id -> tick of its last chase attack; not persisted (resets on restart). */
  const lastChaseAttack = new Map<number, number>();

  function tickNPCs(world: World, tick: number): void {
    for (const entity of world.query(NPC_KIND)) {
      const npc = entity.components.npc;
      const movement = entity.components.movement;
      if (!isNPCComponent(npc) || !isMovementComponent(movement)) continue;

      // 1. Spatial sleeping: with no player within the activation radius
      // this NPC costs nothing — not even a log line.
      if (!world.hasPlayerNear(entity.x, entity.y, NPC_ACTIVATION_RADIUS)) {
        if (!sleeping.has(entity.id)) {
          sleeping.add(entity.id);
          console.log(
            `[npc] #${entity.id} sleeping at (${entity.x}, ${entity.y}) - no players within ` +
              `${NPC_ACTIVATION_RADIUS} tiles`,
          );
        }
        continue;
      }
      if (sleeping.delete(entity.id)) {
        console.log(`[npc] #${entity.id} woke at (${entity.x}, ${entity.y}) - player nearby`);
      }

      // Timers persist across restarts while the world tick restarts at 0:
      // clamp stale future timestamps so a restored NPC acts immediately.
      if (movement.nextMoveTick > tick) movement.nextMoveTick = tick;
      if (npc.lastActionTick > tick) npc.lastActionTick = tick;

      // 2. AI dispatch (guarded for feature AIs), then 3. movement.
      const nearby = nearbyEntities(world, entity, NPC_NEARBY_RADIUS);
      runAI(options, entity, nearby, tick, warnedAis);
      applyMovement(world, entity, npc, movement, tick);

      // 4. Chase attacks (Phase 7): a chasing NPC whose target is adjacent
      //    swings at it every CHASE_ATTACK_INTERVAL ticks. This is a direct
      //    call into the core combat system — intents come from network
      //    sessions, NPCs act on their own. handleAttack re-checks stats and
      //    adjacency, so a vanished target is a harmless no-op.
      if (npc.state === 'chasing' && typeof npc.target === 'number') {
        const target = world.get(npc.target);
        if (target && abs(target.x - entity.x) <= 1 && abs(target.y - entity.y) <= 1) {
          const last = lastChaseAttack.get(entity.id) ?? -Infinity;
          if (tick - last >= CHASE_ATTACK_INTERVAL) {
            lastChaseAttack.set(entity.id, tick);
            handleAttack(options.combat, entity.id, npc.target);
          }
        }
      }

      // The AI mutates components even when no tile moved; persist the
      // whole entity so state survives restarts.
      world.markDirty(entity.id);
    }
  }

  return {
    name: 'core:npc-ai',
    run: (_deltaSeconds: number, tick: number): void => {
      tickNPCs(options.world, tick);
    },

    onDamage(payload: unknown): void {
      const event = payload as Partial<DamageEvent>;
      if (typeof event.targetId !== 'number') return;
      const entity = options.world.get(event.targetId);
      if (!entity) return; // despawned before the bus flush
      const npc = entity.components.npc;
      if (!isNPCComponent(npc) || npc.state === 'chasing') return;
      npc.state = 'chasing';
      npc.target = typeof event.sourceId === 'number' ? event.sourceId : undefined;
      options.world.markDirty(entity.id);
    },
  };
}
