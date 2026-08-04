import type { DatabaseSync } from 'node:sqlite';
import type { WorldCoord } from '@game/shared';
import { saveEntity, saveTile } from './db.ts';
import type { EntityRow } from './db.ts';

export type TileKind = 'grass' | 'wall';

export interface Entity {
  id: number;
  kind: string;
  x: number;
  y: number;
  components: Record<string, unknown>;
  /** Chunk key this entity lives in. The world is one chunk today, so always '0,0'. */
  chunk: string;
}

export const DEFAULT_WIDTH = 20;
export const DEFAULT_HEIGHT = 15;

/** Chunk key holding the entire tilemap while the world is a single chunk. */
export const TILE_CHUNK = '0,0';

/**
 * The world owns all game state: the entity store and the tile map.
 *
 * It is deliberately a dumb state bag with a small mutation surface
 * (spawn/get/query/despawn/tile/setTile) so that later phases can bolt
 * persistence and a feature plugin system on top without changing how
 * game code talks to it.
 *
 * Persistence: every mutation marks something dirty (an entity id in
 * `dirty`, or the whole tilemap), and `flushDirty(db)` writes the dirty
 * state out. An id in the dirty set that is no longer in the world means
 * the entity was despawned, so its row is deleted. `loadFromRows` /
 * `loadTilesBlob` restore state saved by an earlier flush.
 *
 * `rng()` is a small seeded LCG. `Math.random` is banned by lint; every
 * bit of randomness in the world must flow through here so that worlds
 * are reproducible from a seed.
 */
export class World {
  readonly width: number;
  readonly height: number;

  private readonly entities = new Map<number, Entity>();
  private tiles: TileKind[][];
  private nextId = 1;
  private rngState: number;

  /** Entity ids changed since the last flush; ids that vanished mean "delete the row". */
  private readonly dirty = new Set<number>();
  private tileDirty = false;

  constructor(width: number = DEFAULT_WIDTH, height: number = DEFAULT_HEIGHT, seed?: number) {
    this.width = width;
    this.height = height;
    this.rngState = seed ?? Date.now() % 2 ** 32;

    this.tiles = Array.from({ length: height }, () =>
      Array.from({ length: width }, () => 'grass' as TileKind),
    );
    // Walls around the edges; the inside is open grass.
    for (let x = 0; x < width; x++) {
      this.tiles[0][x] = 'wall';
      this.tiles[height - 1][x] = 'wall';
    }
    for (let y = 0; y < height; y++) {
      this.tiles[y][0] = 'wall';
      this.tiles[y][width - 1] = 'wall';
    }
  }

  /** Deterministic pseudo-random number in [0, 1). Never use Math.random. */
  rng(): number {
    this.rngState = (this.rngState * 1664525 + 1013904223) >>> 0;
    return this.rngState / 2 ** 32;
  }

  /** Spawn an entity at a position; returns its id. */
  spawn(kind: string, pos: WorldCoord, components: Record<string, unknown> = {}): number {
    const id = this.nextId++;
    this.entities.set(id, { id, kind, x: pos.x, y: pos.y, components, chunk: TILE_CHUNK });
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

  despawn(id: number): void {
    this.entities.delete(id);
    this.dirty.add(id);
  }

  /** Record that an entity was modified in place (e.g. a move). */
  markDirty(id: number): void {
    this.dirty.add(id);
  }

  /** Number of entities awaiting persistence. */
  get dirtyCount(): number {
    return this.dirty.size;
  }

  /** Tile kind at (x, y); out-of-bounds reads as 'wall'. */
  tile(x: number, y: number): TileKind {
    return this.inBounds(x, y) ? this.tiles[y][x] : 'wall';
  }

  setTile(x: number, y: number, kind: TileKind): void {
    if (this.inBounds(x, y)) {
      this.tiles[y][x] = kind;
      this.tileDirty = true;
    }
  }

  isWalkable(x: number, y: number): boolean {
    return this.inBounds(x, y) && this.tiles[y][x] !== 'wall';
  }

  /**
   * Write every dirty entity (and the tilemap, if it changed) to the db.
   * Entities that were despawned since the last flush have no in-memory
   * entity anymore, so their rows are deleted.
   */
  flushDirty(db: DatabaseSync): void {
    const deleteRow = db.prepare('DELETE FROM entities WHERE id = ?');
    for (const id of this.dirty) {
      const entity = this.entities.get(id);
      if (entity) saveEntity(db, entity);
      else deleteRow.run(id);
    }
    this.dirty.clear();
    if (this.tileDirty) {
      saveTile(db, TILE_CHUNK, this.tilesToBlob());
      this.tileDirty = false;
    }
  }

  /**
   * Restore entities saved by an earlier flush. Position and components
   * come from the `data` blob; the blob layout may grow, but never shrink
   * or move — unknown fields are ignored so old rows always load.
   */
  loadFromRows(rows: EntityRow[]): void {
    for (const row of rows) {
      let parsed: { x: unknown; y: unknown; components: unknown };
      try {
        parsed = JSON.parse(row.data) as { x: unknown; y: unknown; components: unknown };
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
      this.entities.set(row.id, {
        id: row.id,
        kind: row.kind,
        x: parsed.x,
        y: parsed.y,
        components: parsed.components as Record<string, unknown>,
        chunk: row.chunk || TILE_CHUNK,
      });
      if (row.id >= this.nextId) this.nextId = row.id + 1;
    }
    if (rows.length > 0) {
      console.log(`[world] restored ${rows.length} entities; next id is ${this.nextId}`);
    }
  }

  /** Serialize the whole tilemap as one JSON blob (single chunk for now). */
  tilesToBlob(): Buffer {
    return Buffer.from(
      JSON.stringify({ width: this.width, height: this.height, tiles: this.tiles }),
      'utf8',
    );
  }

  /**
   * Restore the tilemap from a blob written by `tilesToBlob`. Returns false
   * (and keeps the current map) if the blob is corrupt or sized differently.
   */
  loadTilesBlob(data: Uint8Array): boolean {
    try {
      const parsed = JSON.parse(Buffer.from(data).toString('utf8')) as {
        width: unknown;
        height: unknown;
        tiles: unknown;
      };
      if (
        typeof parsed.width !== 'number' ||
        typeof parsed.height !== 'number' ||
        !Array.isArray(parsed.tiles) ||
        parsed.tiles.length !== this.height ||
        parsed.tiles.some(
          (row) => !Array.isArray(row) || row.length !== this.width,
        )
      ) {
        return false;
      }
      this.tiles = parsed.tiles as TileKind[][];
      return true;
    } catch {
      return false;
    }
  }

  private inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }
}
