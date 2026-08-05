import {
  definePlugin,
  isMovementComponent,
  isNPCComponent,
  type DamageEvent,
  type Direction,
  type EntityState,
  type MovementComponent,
  type NPCComponent,
  type WorldAPI,
  type WorldCoord,
} from '@game/shared';

/**
 * The npc feature — wandering, chasing, fleeing, fighting-back creatures,
 * entirely outside core.
 *
 * NPCs are game content, so none of this lives in `packages/*`. What core
 * still owns is what core has always owned: tiles, collision, positions and
 * the spatial index. This feature never touches any of it directly — it
 * asks, through the sanctioned WorldAPI:
 *
 *   world.move(id, x, y)              request a step; core validates the tile
 *   world.walkable(x, y)              core's collision rule, read-only
 *   world.hasPlayerNear(x, y, r)      the spatial-sleeping probe
 *   world.queryNear(x, y, r)          detached neighbours, off the same index
 *   world.get / update / spawn        read a copy, write components back
 *   world.emit                        announce a swing ('npc:attack')
 *
 * What it registers:
 *  - one entity kind:  'npc' (see entityKinds below for why it is not
 *                      namespaced)
 *  - one system:       'npc:tick' — bootstrap, spatial sleeping, AI dispatch,
 *                      movement, chase attacks
 *  - two listeners:    'entity:damage' (a hurt NPC turns on its attacker) and
 *                      'npc:register-ais' (this feature's own extension
 *                      point — see "Behaviours" below)
 *  - one event out:    'npc:attack' { attackerId, targetId } when a chasing
 *                      NPC swings at an adjacent target. What a swing DOES is
 *                      combat's business; with features/combat uninstalled,
 *                      swings are inert.
 *
 * Behaviours (the AI registry). There is no core AI registry any more: this
 * feature owns the concept, and other features plug into it through the
 * ordinary event bus. On its first tick 'npc:tick' emits
 *
 *     world.emit('npc:register-ais', { register })
 *
 * and any feature can answer from its own `events` map:
 *
 *     events: {
 *       'npc:register-ais': (world, payload) => {
 *         const register = (payload as { register?: unknown }).register;
 *         if (typeof register !== 'function') return;
 *         register('myfeature:brain', (world, entity, nearby, tick) => { ... });
 *       },
 *     }
 *
 * So cross-feature behaviours still work, with no import between features and
 * no NPC concept in core. See README.md for the full contract.
 */

/** The NPC entity kind. Persisted rows carry it, so it is not renamed. */
export const NPC_KIND = 'npc';

/** Default wander speed in tiles per tick: one tile every 5 ticks. */
export const NPC_SPEED = 0.2;

/** Default stats: what makes an NPC damageable and able to hit back. */
const NPC_STATS = { hp: 30, maxHp: 30, atk: 8, def: 2, level: 1 };

/**
 * NPCs with a player within this many tiles are awake; everyone else sleeps.
 * 64 = one chunk, the core spatial-index granularity.
 */
export const NPC_ACTIVATION_RADIUS = 64;

/**
 * Chunks are 64x64 tiles, so `tile >> 6` is the chunk coordinate. The leash
 * anchor stored in `npc.spawnChunk` is core's 'cx,cy' chunk key.
 */
const CHUNK_SHIFT = 6;

/** Awake NPCs receive this list of nearby entities to react to. */
export const NPC_NEARBY_RADIUS = 6;

/** How many NPCs a fresh world is seeded with, and the box they land in. */
const SCATTER_COUNT = 20;
const SCATTER_AREA = 20;

/** kv flag claiming the one-time scatter; survives restarts. */
const SEEDED_FLAG = 'npc:seeded';

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

/** How far a chase path may search before it gives up and heads roughly there. */
const CHASE_PATH_STEPS = 30;

/** A registered behaviour that throws this many times in a row is dropped. */
const AI_MAX_STRIKES = 3;

const DIRECTIONS: readonly Direction[] = ['n', 's', 'e', 'w'];

const DELTA: Record<Direction, WorldCoord> = {
  n: { x: 0, y: -1 },
  s: { x: 0, y: 1 },
  e: { x: 1, y: 0 },
  w: { x: -1, y: 0 },
};

// The project bans the Math global (lint); these are the only helpers needed.
function abs(value: number): number {
  return value < 0 ? -value : value;
}

/** Wrap a coordinate onto the torus world, exactly as core's move() does. */
function wrap(value: number, size: number): number {
  return ((value % size) + size) % size;
}

/**
 * An NPC behaviour. `entity` is a DETACHED snapshot of the NPC: mutate its
 * `npc` and `movement` components to change state and request movement (set
 * `movement.dir`), and this feature writes them back through world.update()
 * and performs the actual step. Never assign `entity.x`/`entity.y` — that is
 * core's, via world.move(). `nearby` holds detached copies too.
 */
export type NpcAI = (
  world: WorldAPI,
  entity: EntityState,
  nearby: EntityState[],
  tick: number,
) => void;

// ── Pathfinding ─────────────────────────────────────────────────────────────

/**
 * Bounded grid A* for NPC navigation.
 *
 * Deliberately simple: uniform cost (1 per tile), Manhattan heuristic, a
 * plain array sorted by f as the priority queue. A real open-list heap or a
 * jump-point variant would be faster, but NPC searches are tiny and bounded —
 * `maxSteps` caps the work before a search ever gets expensive, which is the
 * actual requirement (no NPC may pathfind across the whole 10000x10000
 * world).
 *
 * Walkability comes from core (`world.walkable`), so a path can never route
 * through water even if this file is wrong about the map.
 *
 * Returns the path from the start to the goal — first element is the start —
 * or, when the goal is unreachable or `maxSteps` is exhausted, the path to
 * the walkable node that got closest to the goal (possibly just the start
 * itself). Callers take `path[1]` as the first step.
 */
interface PathNode {
  x: number;
  y: number;
  /** Cost from the start (uniform: 1 per tile). */
  g: number;
  /** g + Manhattan distance to the goal; the sort key. */
  f: number;
  parent: PathNode | undefined;
}

function pathKey(x: number, y: number): string {
  return `${x},${y}`;
}

function heuristic(x: number, y: number, toX: number, toY: number): number {
  return abs(x - toX) + abs(y - toY);
}

/** Walk the parent chain from the goal (or best) node back to the start. */
function reconstruct(node: PathNode): WorldCoord[] {
  const path: WorldCoord[] = [];
  let current: PathNode | undefined = node;
  while (current) {
    path.push({ x: current.x, y: current.y });
    current = current.parent;
  }
  path.reverse();
  return path;
}

export function findPath(
  world: WorldAPI,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  maxSteps: number = CHASE_PATH_STEPS,
): WorldCoord[] {
  if (fromX === toX && fromY === toY) return [{ x: fromX, y: fromY }];

  const start: PathNode = {
    x: fromX,
    y: fromY,
    g: 0,
    f: heuristic(fromX, fromY, toX, toY),
    parent: undefined,
  };
  const open: PathNode[] = [start];
  const visited = new Set<string>([pathKey(fromX, fromY)]);
  let expanded = 0;
  // The walkable node closest to the goal so far — the fallback path target
  // when the search exhausts maxSteps or finds no route.
  let best: PathNode = start;
  let bestH = start.f;

  while (open.length > 0) {
    // Crude priority queue: sort by f on every pop. A few hundred nodes at
    // most, and only for chasing/fleeing NPCs — plenty fast, keep it simple.
    open.sort((a, b) => a.f - b.f);
    const current = open.shift()!;

    if (current.x === toX && current.y === toY) return reconstruct(current);

    expanded++;
    if (expanded > maxSteps) break;

    const h = heuristic(current.x, current.y, toX, toY);
    if (h < bestH) {
      bestH = h;
      best = current;
    }

    for (const dir of DIRECTIONS) {
      const delta = DELTA[dir];
      const nx = current.x + delta.x;
      const ny = current.y + delta.y;
      const k = pathKey(nx, ny);
      if (visited.has(k)) continue;
      if (!world.walkable(nx, ny)) continue; // water, mountains, out of bounds
      visited.add(k);
      const g = current.g + 1;
      open.push({ x: nx, y: ny, g, f: g + heuristic(nx, ny, toX, toY), parent: current });
    }
  }

  // Goal unreachable within maxSteps: the closest node we actually reached.
  return reconstruct(best);
}

// ── Spawning ────────────────────────────────────────────────────────────────

/**
 * Spawn one NPC at (x, y) with the given behaviour. `kind` is usually
 * NPC_KIND ('npc'); a feature may pass its own kind to give NPCs a distinct
 * sprite while reusing this system. Returns the entity id.
 *
 * The three components an NPC carries:
 *  - `npc`      — the brain: behaviour name, state, and the leash anchor.
 *  - `movement` — best-effort stepping: one tile every `1/speed` ticks.
 *  - `stats`    — hp/maxHp/atk/def, so combat can damage it and it can hit
 *                 back. The client draws a health bar from these.
 */
export function spawnNPC(world: WorldAPI, kind: string, x: number, y: number, ai: string): number {
  return world.spawn(
    kind,
    { x, y },
    {
      npc: {
        ai,
        state: 'idle',
        lastActionTick: 0,
        spawnChunk: `${x >> CHUNK_SHIFT},${y >> CHUNK_SHIFT}`,
      },
      movement: { speed: NPC_SPEED, nextMoveTick: 0 },
      stats: { ...NPC_STATS },
    },
  );
}

/**
 * Scatter `count` wandering NPCs on random walkable, unoccupied tiles inside
 * the box at the centre of the world (players spawn there too). Seeded via
 * world.rng(), so a given world seed always scatters the same population.
 * Returns how many actually spawned.
 */
export function scatterNPCs(
  world: WorldAPI,
  count: number,
  area: number = SCATTER_AREA,
): number {
  const cx = (world.width / 2) | 0;
  const cy = (world.height / 2) | 0;
  const half = (area / 2) | 0;

  let spawned = 0;
  for (let i = 0; i < count; i++) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const x = cx - half + ~~(world.rng() * area);
      const y = cy - half + ~~(world.rng() * area);
      if (!world.walkable(x, y)) continue;
      if (world.queryNear(x, y, 0).length > 0) continue; // tile already taken
      spawnNPC(world, NPC_KIND, x, y, 'wander');
      spawned++;
      break;
    }
  }
  return spawned;
}

// ── The built-in 'wander' behaviour ─────────────────────────────────────────

/** Ticks between moves for a movement component's speed (0.2 -> 5). */
function moveInterval(speed: number): number {
  if (!(speed > 0)) return DEFAULT_MOVE_INTERVAL;
  const ticks = ~~(1 / speed + 0.5);
  return ticks < 1 ? 1 : ticks;
}

/** The compass direction from `entity` onto `step` (a pathfinding result). */
function directionTo(entity: EntityState, step: WorldCoord): Direction {
  if (step.x > entity.x) return 'e';
  if (step.x < entity.x) return 'w';
  if (step.y > entity.y) return 's';
  return 'n';
}

/** The walkable step that moves furthest from the fleeing target. */
function fleeDirection(
  world: WorldAPI,
  entity: EntityState,
  target: EntityState,
): Direction | undefined {
  let best: Direction | undefined;
  let bestDist = -1;
  for (const dir of DIRECTIONS) {
    const delta = DELTA[dir];
    const tx = entity.x + delta.x;
    const ty = entity.y + delta.y;
    if (!world.walkable(tx, ty)) continue;
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
  return abs((x >> CHUNK_SHIFT) - ax) <= LEASH_CHUNKS && abs((y >> CHUNK_SHIFT) - ay) <= LEASH_CHUNKS;
}

/**
 * A random walkable direction that keeps the NPC on its leash, or undefined
 * when every candidate is blocked or off-leash (the NPC waits and tries
 * again next action).
 */
function pickWanderDir(
  world: WorldAPI,
  entity: EntityState,
  npc: NPCComponent,
): Direction | undefined {
  const order = [0, 1, 2, 3].sort(() => world.rng() - 0.5);
  for (const i of order) {
    const dir = DIRECTIONS[i];
    const delta = DELTA[dir];
    const tx = entity.x + delta.x;
    const ty = entity.y + delta.y;
    if (!world.walkable(tx, ty)) continue;
    if (!withinLeash(npc, tx, ty)) continue;
    return dir;
  }
  return undefined;
}

/**
 * The built-in behaviour for `npc.ai === 'wander'` (and the fallback for
 * unknown or broken names). Decides state and direction only — the system
 * applies movement afterwards.
 */
function runBuiltinWander(world: WorldAPI, entity: EntityState, tick: number): void {
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
        const path = findPath(world, entity.x, entity.y, target.x, target.y, CHASE_PATH_STEPS);
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

// ── The system ──────────────────────────────────────────────────────────────

/**
 * Build the system closure. All the per-process state lives in here — a
 * cache, some log-dedupe sets and a tick counter; the world itself is the
 * only source of truth, and every bit of it rebuilds harmlessly after a
 * restart. The plugin below instantiates exactly one; it is exported so
 * verification scripts can drive a fresh, isolated instance per world.
 */
export function createNPCSystem(): (world: WorldAPI, delta: number) => void {
  /** Registered behaviours by name; 'wander' is the built-in and not in here. */
  const ais = new Map<string, NpcAI>();
  /** Behaviours dropped after AI_MAX_STRIKES throws; they fall back to wander. */
  const brokenAis = new Set<string>();
  const aiStrikes = new Map<string, number>();
  /** NPCs currently asleep; wakes/sleeps are logged once per transition. */
  const sleeping = new Set<number>();
  /** Unknown ai names already warned about (log each name once). */
  const warnedAis = new Set<string>();
  /** NPC id -> tick of its last chase attack; not persisted (resets on restart). */
  const lastChaseAttack = new Map<number, number>();
  /**
   * This feature's own tick counter. Core's loop starts at 1 on every boot
   * and does not persist its tick number, so a counter incremented once per
   * system run is exactly the same number — and it keeps the tick out of the
   * SystemDef signature, which every other feature would have to carry.
   */
  let tick = 0;
  let bootstrapped = false;

  /**
   * The extension point handed to other features in the 'npc:register-ais'
   * payload. Deliberately paranoid: it is called by foreign code.
   */
  function register(name: unknown, fn: unknown): void {
    if (typeof name !== 'string' || name.length === 0 || typeof fn !== 'function') return;
    if (name === 'wander') {
      console.warn(`[npc] refusing to register '${name}': that name is the built-in behaviour`);
      return;
    }
    if (ais.has(name)) {
      console.warn(`[npc] behaviour '${name}' is already registered - ignoring the second one`);
      return;
    }
    ais.set(name, fn as NpcAI);
    console.log(`[npc] behaviour '${name}' registered`);
  }

  /** Dispatch to the registered behaviour, or the built-in wander. */
  function runAI(world: WorldAPI, entity: EntityState, nearby: EntityState[]): void {
    const npc = entity.components.npc as NPCComponent;
    const name = npc.ai;
    const fn = brokenAis.has(name) ? undefined : ais.get(name);
    if (fn) {
      // A foreign behaviour runs inside this feature's system, so core's
      // guard would blame 'npc:tick' for someone else's bug. Catch it here
      // and drop the behaviour after AI_MAX_STRIKES instead.
      try {
        fn(world, entity, nearby, tick);
        aiStrikes.delete(name);
      } catch (err) {
        const strikes = (aiStrikes.get(name) ?? 0) + 1;
        aiStrikes.set(name, strikes);
        world.log(
          `behaviour '${name}' threw (${strikes}/${AI_MAX_STRIKES}): ` +
            (err instanceof Error ? err.message : String(err)),
        );
        if (strikes >= AI_MAX_STRIKES) {
          brokenAis.add(name);
          world.log(`behaviour '${name}' disabled after ${AI_MAX_STRIKES} throws - using 'wander'`);
        }
        runBuiltinWander(world, entity, tick);
      }
      return;
    }
    if (name !== 'wander' && !warnedAis.has(name)) {
      warnedAis.add(name);
      console.warn(`[npc] #${entity.id}: ai '${name}' is not registered - using built-in 'wander'`);
    }
    runBuiltinWander(world, entity, tick);
  }

  /**
   * Step one tile in the requested direction when a move is due. The AI only
   * set `movement.dir`; this is where the position actually changes — and
   * even here the change is a REQUEST: core validates the tile and refuses
   * the ones an entity may not stand on.
   */
  function applyMovement(
    world: WorldAPI,
    entity: EntityState,
    npc: NPCComponent,
    movement: MovementComponent,
  ): void {
    if (!movement.dir || tick < movement.nextMoveTick) return;
    const delta = DELTA[movement.dir];
    const tx = entity.x + delta.x;
    const ty = entity.y + delta.y;
    if (world.move(entity.id, tx, ty)) {
      // Keep the detached snapshot in step with the world, so the adjacency
      // check below measures from the tile the NPC actually stands on.
      entity.x = wrap(tx, world.width);
      entity.y = wrap(ty, world.height);
      npc.lastActionTick = tick;
      movement.nextMoveTick = tick + moveInterval(movement.speed);
    } else {
      // Blocked: drop the direction so the AI picks a fresh one, and wait a
      // beat so a wall hit reads as a pause, not a frantic buzz.
      movement.dir = undefined;
      movement.nextMoveTick = tick + moveInterval(movement.speed);
    }
  }

  /**
   * A chasing NPC whose target is adjacent swings every CHASE_ATTACK_INTERVAL
   * ticks. This feature decides WHEN an NPC swings (that is AI); what a swing
   * DOES belongs to whichever feature owns damage, so all that happens here
   * is an announcement. With features/combat uninstalled, swings are inert.
   */
  function maybeAttack(world: WorldAPI, entity: EntityState, npc: NPCComponent): void {
    if (npc.state !== 'chasing' || typeof npc.target !== 'number') return;
    const target = world.get(npc.target);
    if (!target || abs(target.x - entity.x) > 1 || abs(target.y - entity.y) > 1) return;
    const last = lastChaseAttack.get(entity.id) ?? -Infinity;
    if (tick - last < CHASE_ATTACK_INTERVAL) return;
    lastChaseAttack.set(entity.id, tick);
    world.emit('npc:attack', { attackerId: entity.id, targetId: npc.target });
  }

  /**
   * One-time work on the first tick: offer the behaviour registry to other
   * features, and seed a fresh world with a small wandering population near
   * the centre (players spawn there, so the world reads alive from the first
   * moment). The kv flag is claimed in the same call that reads it, so a
   * restart never double-seeds; the extra entity check protects worlds that
   * predate the flag.
   */
  function bootstrap(world: WorldAPI): void {
    bootstrapped = true;
    world.emit('npc:register-ais', { register });

    const alreadySeeded = world.getSet(SEEDED_FLAG, '1') !== undefined;
    if (alreadySeeded) return;
    if (world.query('npc').length > 0) return;
    const spawned = scatterNPCs(world, SCATTER_COUNT);
    world.log(`spawned ${spawned} wandering NPCs near the world centre`);
  }

  return function tickNPCs(world: WorldAPI): void {
    tick++;
    if (!bootstrapped) {
      // The scatter and the offer are the whole of this tick's work. Core's
      // guard allows a system 5ms and disables it after three consecutive
      // overruns; doing the one-time bootstrap and a full NPC pass in the
      // same (cold, unJITted) tick is the one place that ever came close.
      // Nothing observable waits a tick: on a fresh world nobody is
      // connected yet, and a freshly scattered NPC starts out idle.
      bootstrap(world);
      return;
    }

    for (const entity of world.query('npc')) {
      const npc = entity.components.npc;
      const movement = entity.components.movement;
      if (!isNPCComponent(npc) || !isMovementComponent(movement)) continue;

      // 1. SPATIAL SLEEPING — the whole point. With no player within the
      //    activation radius this NPC costs nothing: no AI, no path search,
      //    not even a log line.
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

      // Timers persist across restarts while the tick counter restarts at 0:
      // clamp stale future timestamps so a restored NPC acts immediately.
      if (movement.nextMoveTick > tick) movement.nextMoveTick = tick;
      if (npc.lastActionTick > tick) npc.lastActionTick = tick;

      // 2. AI DISPATCH. `entity` is a detached copy; the behaviour mutates
      //    its npc/movement components and they are written back below.
      const nearby = world
        .queryNear(entity.x, entity.y, NPC_NEARBY_RADIUS)
        .filter((e) => e.id !== entity.id);
      runAI(world, entity, nearby);

      // Re-read: a behaviour is allowed to replace a whole component.
      const brain = entity.components.npc;
      const legs = entity.components.movement;
      if (!isNPCComponent(brain) || !isMovementComponent(legs)) continue;

      // 3. MOVEMENT, then 4. chase attacks.
      applyMovement(world, entity, brain, legs);
      maybeAttack(world, entity, brain);

      // The behaviour changes components even on ticks where no tile moved,
      // so write both back every tick: update() persists them and marks the
      // entity dirty. (world.move already marked it for the position.)
      world.update(entity.id, { npc: brain, movement: legs });
    }
  };
}

export default definePlugin({
  id: 'npc',
  items: [],
  recipes: [],
  // 'npc' predates the namespacing rule and is baked into persisted rows, so
  // it is deliberately not declared here — entityKinds ids must be
  // 'feature:thing', and renaming the kind would orphan every existing NPC.
  entityKinds: [],

  systems: [
    {
      name: 'npc:tick',
      fn: createNPCSystem(),
    },
  ],

  commands: [],

  events: {
    /**
     * A hurt NPC drops what it was doing and turns on its attacker. The event
     * is spatial (emitted near the victim by whichever feature deals damage),
     * so this runs once per entity in the blast radius — hence the early
     * return when the target is already chasing, which makes it idempotent.
     */
    'entity:damage': (world, payload) => {
      const event = payload as Partial<DamageEvent>;
      if (typeof event.targetId !== 'number') return;
      const entity = world.get(event.targetId);
      if (!entity) return; // despawned before the bus flush
      const npc = entity.components.npc;
      if (!isNPCComponent(npc) || npc.state === 'chasing') return;
      world.update(event.targetId, {
        npc: {
          ...npc,
          state: 'chasing',
          target: typeof event.sourceId === 'number' ? event.sourceId : undefined,
        },
      });
    },
  },
});
