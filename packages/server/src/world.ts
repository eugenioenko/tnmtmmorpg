import type { DatabaseSync } from 'node:sqlite';
import {
  OVERWORLD,
  isCarvedWorld,
  TILE_GRASS,
  TILE_VOID,
  WALKABLE_TILES,
  resolveWorld,
  type WorldCoord,
  type WorldSpec,
} from '@game/shared';
import { getSet as kvGetSet, saveEntities } from './db.ts';
import type { EntityRow } from './db.ts';
import {
  CHUNK_SHIFT,
  CHUNK_SIZE,
  chunkKey,
  generateChunk as generateChunkData,
  worldToChunk,
  ChunkStore,
  type TileKind,
} from './world-chunks.ts';

// Re-exported so existing importers keep working unchanged.
export {
  CHUNK_SIZE,
  CHUNK_SHIFT,
  TILE_GRASS,
  TILE_NAMES,
  chunkKey,
  worldToChunk,
  type TileKind,
} from './world-chunks.ts';

// The viewport window is defined once in @game/shared: the server sends
// exactly this many tiles and the client draws exactly this many. Re-exported
// so existing server imports keep working.
export { VIEW_RADIUS_X, VIEW_RADIUS_Y } from '@game/shared';
export const DEFAULT_WORLD_WIDTH = 10000;
export const DEFAULT_WORLD_HEIGHT = 10000;
export const DEFAULT_WORLD_SEED = 42;

export interface Entity {
  id: number;
  kind: string;
  x: number;
  y: number;
  components: Record<string, unknown>;
  /**
   * Which world this entity is in. Everything spatial is scoped by it: two
   * entities at the same (x, y) in different worlds are nowhere near each
   * other. Persisted inside the entity's JSON blob, so adding it needed no
   * schema change, and rows written before worlds existed load as OVERWORLD.
   */
  world: string;
  /** Chunk key this entity lives in (e.g. '3,7'); maintained by the spatial index. */
  chunk: string;
}

/**
 * The world owns all game state: the entity store, the entity spatial index
 * and a sparse, chunk-based tile map.
 *
 * The tile map is `Map<chunkKey, Uint8Array>` — one 64x64 array per chunk,
 * allocated lazily (see ChunkStore in world-chunks.ts). An unvisited
 * 10000x10000 world costs a few bytes of map overhead; memory grows only
 * with the area players actually touch. Chunks are generated
 * deterministically from (world seed, chunk coords) on first read, and
 * modified chunks are persisted individually.
 *
 * Persistence: every mutation marks something dirty (an entity id in
 * `dirty`, a chunk key in ChunkStore's dirty set), and `flushDirty(db)`
 * writes the dirty state out. An id in the dirty set that is no longer in
 * the world means the entity was despawned, so its row is deleted.
 * `loadFromRows` / `loadChunks` restore state saved by an earlier flush.
 *
 * `rng()` is a small seeded LCG. `Math.random` is banned by lint; every
 * bit of randomness in the world must flow through here (or through the
 * per-chunk LCG) so that worlds are reproducible from a seed.
 */
export class World {
  readonly width: number;
  readonly height: number;
  /** Seed for deterministic chunk generation. */
  readonly seed: number;

  private readonly entities = new Map<number, Entity>();
  /**
   * One tile map per world, created on first touch. An unvisited world costs
   * nothing until something reads a tile in it, which is what makes five
   * 10000x10000 worlds plus a store per building affordable.
   */
  private readonly stores = new Map<string, ChunkStore>();
  /**
   * Entity spatial index: 'world|cx,cy' -> entity ids. Scoping the key by
   * world is what stops queryNear and hasPlayerNear seeing through the floor
   * into another world at the same coordinates.
   */
  private readonly entityChunks = new Map<string, Set<number>>();
  private nextId = 1;
  private rngState: number;
  /** The persistence handle (for kv flags); undefined in db-less test worlds. */
  private readonly db: DatabaseSync | undefined;
  /** In-memory kv fallback for worlds constructed without a db. */
  private readonly kv = new Map<string, string>();

  /** Entity ids changed since the last flush; ids that vanished mean "delete the row". */
  private readonly dirty = new Set<number>();

  constructor(
    width: number = DEFAULT_WORLD_WIDTH,
    height: number = DEFAULT_WORLD_HEIGHT,
    seed?: number,
    db?: DatabaseSync,
  ) {
    this.width = width;
    this.height = height;
    this.seed = seed ?? DEFAULT_WORLD_SEED;
    this.rngState = seed ?? Date.now() % 2 ** 32;
    this.db = db;
    // The overworld's spec comes from the constructor args so existing
    // callers (tests, tools) keep controlling size and seed directly.
    this.stores.set(
      OVERWORLD,
      new ChunkStore(db, {
        ...(resolveWorld(OVERWORLD) as WorldSpec),
        width,
        height,
        seed: this.seed,
      }),
    );
  }

  /** The spec for a world id, or undefined if nothing mints that id. */
  spec(world: string): WorldSpec | undefined {
    const cached = this.specs.get(world);
    if (cached) return cached;
    const spec =
      world === OVERWORLD
        ? { ...(resolveWorld(OVERWORLD) as WorldSpec), width: this.width, height: this.height, seed: this.seed }
        : resolveWorld(world);
    if (spec) this.specs.set(world, spec);
    return spec;
  }

  /** Resolved specs by world id: every tile read asks, and derived ids parse a string. */
  private readonly specs = new Map<string, WorldSpec>();

  /** Every world with state loaded right now. */
  activeWorlds(): string[] {
    return [...this.stores.keys()];
  }

  /**
   * The tile store for a world, created on first use. Unknown ids fall back
   * to the overworld rather than throwing: a feature that invents a world id
   * should get an empty-but-sane world, not crash the tick.
   */
  private store(world: string): ChunkStore {
    let store = this.stores.get(world);
    if (store) return store;
    const spec = this.spec(world);
    if (!spec) return this.stores.get(OVERWORLD)!;
    store = new ChunkStore(this.db, spec);
    this.stores.set(world, store);
    return store;
  }

  /** Width of a world in tiles (worlds are not all the same size). */
  private widthOf(world: string): number {
    return world === OVERWORLD ? this.width : (this.spec(world)?.width ?? this.width);
  }

  private heightOf(world: string): number {
    return world === OVERWORLD ? this.height : (this.spec(world)?.height ?? this.height);
  }

  /** The spatial-index key for a chunk of a world. */
  private indexKey(world: string, cx: number, cy: number): string {
    return `${world}|${chunkKey(cx, cy)}`;
  }

  /** Deterministic pseudo-random number in [0, 1). Never use Math.random. */
  rng(): number {
    this.rngState = (this.rngState * 1664525 + 1013904223) >>> 0;
    return this.rngState / 2 ** 32;
  }

  /**
   * Persistent kv flag (see db.getSet): read a stored value, or store one
   * and get the previous value back. Writes go to the database immediately
   * when the world has one, so flags survive restarts; db-less test worlds
   * fall back to an in-memory map. Used for one-time bootstrap flags like a
   * feature's 'feature:seeded' marker.
   */
  getSet(k: string, v?: string): string | undefined {
    if (v === undefined) return this.db ? kvGetSet(this.db, k) : this.kv.get(k);
    const prev = this.db ? kvGetSet(this.db, k, v) : this.kv.get(k);
    if (!this.db) this.kv.set(k, v);
    return prev;
  }

  /** Spawn an entity at a position; returns its id. */
  spawn(
    kind: string,
    pos: WorldCoord,
    components: Record<string, unknown> = {},
    world: string = OVERWORLD,
  ): number {
    const id = this.nextId++;
    this.entities.set(id, { id, kind, x: pos.x, y: pos.y, components, world, chunk: '' });
    this.updateEntityChunk(id, pos.x, pos.y);
    this.dirty.add(id);
    return id;
  }

  get(id: number): Entity | undefined {
    return this.entities.get(id);
  }

  /** All entities that carry every named component. */
  query(...componentNames: string[]): Entity[] {
    return [...this.entities.values()].filter((e) =>
      componentNames.every((name) => name in e.components),
    );
  }

  /** Every entity, in insertion order. */
  all(): Entity[] {
    return [...this.entities.values()];
  }

  /**
   * Move an entity to a tile, keeping the spatial index and the dirty set in
   * sync. Callers validate walkability themselves.
   */
  /**
   * Move an entity, wrapping its position around the world edges (torus).
   * Callers validate walkability before calling this.
   */
  moveEntity(id: number, x: number, y: number): void {
    const entity = this.entities.get(id);
    if (!entity) return;
    // Wrap against the entity's OWN world: a 48-tile interior is a much
    // smaller torus than the overworld.
    const w = this.widthOf(entity.world);
    const h = this.heightOf(entity.world);
    entity.x = ((x % w) + w) % w;
    entity.y = ((y % h) + h) % h;
    this.updateEntityChunk(id, entity.x, entity.y);
    this.dirty.add(id);
  }

  /**
   * Move an entity to another world. This is the door, the portal and the
   * way back: the only operation that changes an entity's world.
   *
   * Unlike moveEntity this does not validate walkability — the caller picks
   * an arrival tile, and a feature that drops a player into a wall has a bug
   * the collision rule cannot fix for it.
   */
  travelEntity(id: number, world: string, x: number, y: number): boolean {
    const entity = this.entities.get(id);
    if (!entity) return false;
    if (!this.spec(world)) return false;
    // Leave the old world's index before the world id changes, or the stale
    // entry would be orphaned under a key we can no longer compute.
    const oldSet = this.entityChunks.get(entity.chunk);
    if (oldSet) {
      oldSet.delete(id);
      if (oldSet.size === 0) this.entityChunks.delete(entity.chunk);
    }
    entity.chunk = '';
    entity.world = world;
    const w = this.widthOf(world);
    const h = this.heightOf(world);
    entity.x = ((x % w) + w) % w;
    entity.y = ((y % h) + h) % h;
    this.updateEntityChunk(id, entity.x, entity.y);
    this.dirty.add(id);
    return true;
  }

  despawn(id: number): void {
    const entity = this.entities.get(id);
    if (entity) {
      const set = this.entityChunks.get(entity.chunk);
      if (set) {
        set.delete(id);
        if (set.size === 0) this.entityChunks.delete(entity.chunk);
      }
    }
    this.entities.delete(id);
    this.dirty.add(id);
  }

  /**
   * Chunks generated since the last call. Core hands these to features'
   * decorateChunk hooks at a tick boundary — never on the read path that
   * generated them, since snapshot building calls tile() and spawning there
   * would mutate the entity store mid-serialisation.
   */
  drainFreshChunks(): { cx: number; cy: number }[] {
    // Only the overworld is offered for decoration. Interiors are carved by
    // their generator, and a decorator scattering trees into a building
    // would be scattering them into the void.
    return this.store(OVERWORLD).drainFresh();
  }

  /** Record that an entity was modified in place (e.g. a component change). */
  markDirty(id: number): void {
    this.dirty.add(id);
  }

  /** Number of entities awaiting persistence. */
  get dirtyCount(): number {
    return this.dirty.size;
  }

  /** Number of live entities in the world (players, items, creatures, ...). */
  get entityCount(): number {
    return this.entities.size;
  }

  /** Number of tile chunks currently loaded in memory. */
  get chunkCount(): number {
    let total = 0;
    for (const store of this.stores.values()) total += store.size;
    return total;
  }

  /**
   * Every entity whose chunk is within `viewRadiusX`/`viewRadiusY` tiles of
   * chunk (cx, cy). This is a superset of the exact tile viewport — callers
   * filter by exact coordinates.
   */
  entitiesInView(
    cx: number,
    cy: number,
    viewRadiusX: number,
    viewRadiusY: number,
    world: string = OVERWORLD,
  ): Entity[] {
    const radiusX = (viewRadiusX + (CHUNK_SIZE - 1)) >> CHUNK_SHIFT;
    const radiusY = (viewRadiusY + (CHUNK_SIZE - 1)) >> CHUNK_SHIFT;
    const found = new Set<number>();
    for (let cy2 = cy - radiusY; cy2 <= cy + radiusY; cy2++) {
      for (let cx2 = cx - radiusX; cx2 <= cx + radiusX; cx2++) {
        const set = this.entityChunks.get(this.indexKey(world, cx2, cy2));
        if (!set) continue;
        for (const id of set) found.add(id);
      }
    }
    const result: Entity[] = [];
    for (const id of found) {
      const entity = this.entities.get(id);
      if (entity) result.push(entity);
    }
    return result;
  }

  /**
   * Tile kind at (x, y). Coordinates wrap around the torus — there are no
   * edges. Unloaded chunks are generated deterministically on first read.
   */
  tile(x: number, y: number, world: string = OVERWORLD): TileKind {
    const w = this.widthOf(world);
    const h = this.heightOf(world);
    const wx = ((x % w) + w) % w;
    const wy = ((y % h) + h) % h;
    return this.store(world).tileAt(wx, wy);
  }

  /**
   * The raw tile byte at (x, y) without generating anything. Coordinates
   * wrap around the torus. Unvisited areas read as grass.
   */
  tileByte(x: number, y: number, world: string = OVERWORLD): number {
    const w = this.widthOf(world);
    const h = this.heightOf(world);
    const wx = ((x % w) + w) % w;
    const wy = ((y % h) + h) % h;
    const { cx, cy, lx, ly } = worldToChunk(wx, wy);
    const chunk = this.store(world).getChunk(cx, cy);
    // Ungenerated ground reads as the world's own default: grass outdoors,
    // but VOID inside a building, where "not carved" means "not there".
    if (!chunk) return isCarvedWorld(this.spec(world)) ? TILE_VOID : TILE_GRASS;
    return chunk[ly * CHUNK_SIZE + lx];
  }

  setTile(x: number, y: number, kind: string, world: string = OVERWORLD): void {
    const w = this.widthOf(world);
    const h = this.heightOf(world);
    const wx = ((x % w) + w) % w;
    const wy = ((y % h) + h) % h;
    this.store(world).setTile(wx, wy, kind);
  }

  isWalkable(x: number, y: number, world: string = OVERWORLD): boolean {
    return WALKABLE_TILES.has(this.tileByte(x, y, world));
  }

  /**
   * True when a player entity is within `radius` tiles (Chebyshev) of
   * (x, y). Uses the spatial index, so it costs a handful of chunk-set
   * lookups regardless of how many entities the world holds. This is the
   * spatial-sleeping probe features lean on: an entity whose whole
   * neighborhood holds no player can be skipped entirely for that tick.
   */
  hasPlayerNear(x: number, y: number, radius: number, world: string = OVERWORLD): boolean {
    const { cx, cy } = worldToChunk(x, y);
    const chunkRadius = ((radius + CHUNK_SIZE - 1) / CHUNK_SIZE) | 0;
    for (let dcy = -chunkRadius; dcy <= chunkRadius; dcy++) {
      for (let dcx = -chunkRadius; dcx <= chunkRadius; dcx++) {
        const set = this.entityChunks.get(this.indexKey(world, cx + dcx, cy + dcy));
        if (!set) continue;
        for (const id of set) {
          const entity = this.entities.get(id);
          if (entity && entity.kind === 'player') return true;
        }
      }
    }
    return false;
  }

  /**
   * Every entity id within `radius` tiles (Chebyshev) of (x, y). Uses the
   * spatial index, so it scans only the chunks overlapping the radius
   * instead of the whole entity store. This is the spatial-event probe:
   * emitNear() delivers to exactly these entities and no others.
   */
  entityIdsInRadius(
    x: number,
    y: number,
    radius: number,
    world: string = OVERWORLD,
  ): Set<number> {
    const result = new Set<number>();
    const chunkRadius = ((radius + CHUNK_SIZE - 1) / CHUNK_SIZE) | 0;
    const { cx, cy } = worldToChunk(x, y);

    for (let dcx = -chunkRadius; dcx <= chunkRadius; dcx++) {
      for (let dcy = -chunkRadius; dcy <= chunkRadius; dcy++) {
        const ids = this.entityChunks.get(this.indexKey(world, cx + dcx, cy + dcy));
        if (!ids) continue;
        for (const id of ids) {
          const entity = this.get(id);
          if (!entity) continue;
          // Chunk proximity is only a superset — check the actual Chebyshev
          // distance before admitting an entity.
          const dx = entity.x - x;
          const dy = entity.y - y;
          const adx = dx < 0 ? -dx : dx;
          const ady = dy < 0 ? -dy : dy;
          if (adx <= radius && ady <= radius) result.add(id);
        }
      }
    }
    return result;
  }

  /**
   * The chunk at (cx, cy), generating it deterministically on first use.
   * Freshly generated chunks with any non-grass tile are persisted to the db
   * immediately (when the world was constructed with one), so generated
   * content survives restarts and the db mirrors exactly what was explored.
   */
  ensureChunk(cx: number, cy: number, world: string = OVERWORLD): Uint8Array {
    return this.store(world).ensure(cx, cy);
  }

  /**
   * Deterministic per-chunk generation from the world seed: layered noise
   * (see generateChunk in world-chunks.ts) classifies every tile into one of
   * the 8 terrain kinds. The world wraps like a torus. The same seed always
   * produces the same world.
   */
  generateChunk(cx: number, cy: number): Uint8Array {
    return generateChunkData(this.seed, cx, cy, this.width, this.height);
  }

  /**
   * Write every dirty entity and dirty chunk to the db. Entities that were
   * despawned since the last flush have no in-memory entity anymore, so
   * their rows are deleted. Chunks that were dirtied but never loaded
   * cannot happen (setTile loads before it writes).
   */
  flushDirty(db: DatabaseSync): void {
    // One transaction for the whole flush. Per-entity writes meant one fsync
    // each, so a bulk flush blocked the tick loop for hundreds of ms.
    const writes: Entity[] = [];
    const deletes: number[] = [];
    for (const id of this.dirty) {
      const entity = this.entities.get(id);
      if (entity) writes.push(entity);
      else deletes.push(id); // gone from the world: the row goes too
    }
    if (writes.length > 0 || deletes.length > 0) saveEntities(db, writes, deletes);
    this.dirty.clear();
    for (const store of this.stores.values()) store.flushDirty(db);
  }

  /**
   * Restore entities saved by an earlier flush. Position and components
   * come from the `data` blob; the blob layout may grow, but never shrink
   * or move — unknown fields are ignored so old rows always load. The
   * spatial index is rebuilt from the restored positions.
   */
  loadFromRows(rows: EntityRow[]): void {
    for (const row of rows) {
      let parsed: { x: unknown; y: unknown; components: unknown; world?: unknown };
      try {
        parsed = JSON.parse(row.data) as {
          x: unknown;
          y: unknown;
          components: unknown;
          world?: unknown;
        };
      } catch {
        console.warn(`[world] entity ${row.id}: corrupt data blob - skipping`);
        continue;
      }
      if (
        typeof parsed.x !== 'number' ||
        typeof parsed.y !== 'number' ||
        typeof parsed.components !== 'object' ||
        parsed.components === null
      ) {
        console.warn(`[world] entity ${row.id}: data blob has no x/y/components - skipping`);
        continue;
      }
      // Rows written before worlds existed have no `world`; they are, by
      // definition, in the overworld. That is the entire entity migration.
      const world = typeof parsed.world === 'string' ? parsed.world : OVERWORLD;
      this.entities.set(row.id, {
        id: row.id,
        kind: row.kind,
        x: parsed.x,
        y: parsed.y,
        components: parsed.components as Record<string, unknown>,
        world,
        chunk: '',
      });
      this.updateEntityChunk(row.id, parsed.x, parsed.y);
      if (row.id >= this.nextId) this.nextId = row.id + 1;
    }
    if (rows.length > 0) {
      console.log(`[world] restored ${rows.length} entities; next id is ${this.nextId}`);
    }
  }

  /**
   * Restore persisted chunks (see db.loadChunks). Rows that do not match the
   * current chunk layout are skipped with a warning.
   */
  loadChunks(chunks: Map<string, Uint8Array>): void {
    // Every persisted world gets a store and is offered every row; each takes
    // only the keys carrying its own prefix (bare keys are the overworld's).
    for (const key of chunks.keys()) {
      const colon = key.lastIndexOf(':');
      if (colon > 0) this.store(key.slice(0, colon));
    }
    for (const store of this.stores.values()) store.load(chunks);
    // Restored chunks are decoration CANDIDATES, not automatically decorated.
    // tools/reset-world.mjs generates and persists the spawn chunks before
    // any server runs, so inferring "decorated" from "present in the db"
    // would leave exactly the ground players start on permanently bare.
    // Whether a chunk was decorated is a separate, explicitly recorded fact
    // (see hasDecoratedChunk); offering it here costs one kv read.
    this.store(OVERWORLD).offerForDecoration(
      [...chunks.keys()].filter((k) => k.lastIndexOf(':') < 0),
    );
  }

  /**
   * Claim a chunk for decoration: true the first time it is asked for a
   * given chunk, false forever after. The claim is a persistent kv flag, so
   * it survives restarts — which is what stops a reboot growing a second
   * crop of trees on ground that already has them.
   */
  claimChunkDecoration(cx: number, cy: number): boolean {
    return this.getSet(`chunk:decorated:${cx},${cy}`, '1') === undefined;
  }

  /**
   * Keep the spatial index in sync with an entity's position: remove it from
   * its old chunk set and add it to the chunk containing (x, y).
   */
  private updateEntityChunk(id: number, x: number, y: number): void {
    const entity = this.entities.get(id);
    if (!entity) return;
    const key = this.indexKey(entity.world, x >> CHUNK_SHIFT, y >> CHUNK_SHIFT);
    if (entity.chunk === key) return;
    const oldSet = this.entityChunks.get(entity.chunk);
    if (oldSet) {
      oldSet.delete(id);
      if (oldSet.size === 0) this.entityChunks.delete(entity.chunk);
    }
    entity.chunk = key;
    let set = this.entityChunks.get(key);
    if (!set) {
      set = new Set();
      this.entityChunks.set(key, set);
    }
    set.add(id);
  }
}
