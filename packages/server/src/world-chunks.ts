import type { DatabaseSync } from 'node:sqlite';
import { saveChunk } from './db.ts';

export type TileKind = 'grass' | 'wall';

/** Chunk edge in tiles; each chunk stores CHUNK_SIZE x CHUNK_SIZE tiles. */
export const CHUNK_SIZE = 64;
/** log2(CHUNK_SIZE); a chunk coord is a world coord shifted right by this. */
export const CHUNK_SHIFT = 6;

/** Numeric tile kinds stored in chunk data; indices must match TILE_NAMES. */
export const TILE_GRASS = 0;
export const TILE_WALL = 1;

/** Kind name by numeric value; the world default ('grass') is omitted from snapshots. */
export const TILE_NAMES = ['grass', 'wall'] as const;

const TILE_KINDS: Record<string, number> = { grass: TILE_GRASS, wall: TILE_WALL };

/** The map key of a chunk: 'cx,cy'. */
export function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

/** World tile coords -> chunk coords plus local coords within the chunk. */
export function worldToChunk(
  x: number,
  y: number,
): { cx: number; cy: number; lx: number; ly: number } {
  return {
    cx: x >> CHUNK_SHIFT,
    cy: y >> CHUNK_SHIFT,
    lx: x & (CHUNK_SIZE - 1),
    ly: y & (CHUNK_SIZE - 1),
  };
}

/** A fresh LCG seeded per chunk, so every chunk's layout is deterministic. */
function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** True when the chunk holds any non-grass tile. */
function hasNonGrass(data: Uint8Array): boolean {
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== TILE_GRASS) return true;
  }
  return false;
}

/**
 * Deterministic per-chunk generation from the world seed: the world border
 * is a wall, plus 2-8 small wall clusters of 1-5 tiles at seeded random
 * positions. Everything else stays 0 (grass). The same seed always
 * produces the same world.
 */
export function generateChunk(
  seed: number,
  cx: number,
  cy: number,
  width: number,
  height: number,
): Uint8Array {
  const chunkSeed = seed + cx * 0x9e3779b9 + cy * 0x7f4a7c13;
  const rng = createSeededRng(chunkSeed);
  const data = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);

  // World borders are walls: the first and last chunk column/row hold the
  // tiles on the world edge (positions past the edge are never queried).
  const lastCX = (width - 1) >> CHUNK_SHIFT;
  const lastCY = (height - 1) >> CHUNK_SHIFT;
  if (cx === 0) {
    for (let ly = 0; ly < CHUNK_SIZE; ly++) data[ly * CHUNK_SIZE] = TILE_WALL;
  }
  if (cy === 0) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) data[lx] = TILE_WALL;
  }
  if (cx === lastCX) {
    const ex = (width - 1) & (CHUNK_SIZE - 1);
    for (let ly = 0; ly < CHUNK_SIZE; ly++) data[ly * CHUNK_SIZE + ex] = TILE_WALL;
  }
  if (cy === lastCY) {
    const ey = (height - 1) & (CHUNK_SIZE - 1);
    for (let lx = 0; lx < CHUNK_SIZE; lx++) data[ey * CHUNK_SIZE + lx] = TILE_WALL;
  }

  // Scatter wall clusters: 2-8 per chunk, 1-5 tiles each, grown by a short
  // random walk (clipped back into the chunk if it wanders off the edge).
  const clusters = 2 + ~~(rng() * 7);
  for (let c = 0; c < clusters; c++) {
    const size = 1 + ~~(rng() * 5);
    let lx = ~~(rng() * CHUNK_SIZE);
    let ly = ~~(rng() * CHUNK_SIZE);
    for (let t = 0; t < size; t++) {
      data[ly * CHUNK_SIZE + lx] = TILE_WALL;
      if (rng() < 0.5) lx += rng() < 0.5 ? -1 : 1;
      else ly += rng() < 0.5 ? -1 : 1;
      if (lx < 0) lx = 0;
      else if (lx >= CHUNK_SIZE) lx = CHUNK_SIZE - 1;
      if (ly < 0) ly = 0;
      else if (ly >= CHUNK_SIZE) ly = CHUNK_SIZE - 1;
    }
  }
  return data;
}

/**
 * The world's chunk-based tile map: `Map<chunkKey, Uint8Array>` — one 64x64
 * array per chunk, allocated lazily. An unvisited 10000x10000 world costs a
 * few bytes of map overhead; memory grows only with the area players
 * actually touch. Chunks are generated deterministically from (world seed,
 * chunk coords) on first read, and modified chunks are persisted
 * individually.
 *
 * Persistence: every mutation marks the chunk dirty, and `flushDirty(db)`
 * writes the dirty state out. Freshly generated chunks with any non-grass
 * tile are persisted immediately, so generated content survives restarts
 * and the db mirrors exactly what was explored. `load` restores state saved
 * by an earlier flush.
 */
export class ChunkStore {
  /** Loaded chunks by key ('cx,cy') -> raw tile data (see TILE_* constants). */
  private readonly chunks = new Map<string, Uint8Array>();
  /** Chunks whose tiles changed since the last flush; each is persisted on flush. */
  private readonly dirtyChunks = new Set<string>();
  /** When present, freshly generated non-grass chunks are persisted immediately. */
  private readonly db: DatabaseSync | undefined;
  private readonly width: number;
  private readonly height: number;
  private readonly seed: number;

  constructor(db: DatabaseSync | undefined, width: number, height: number, seed: number) {
    this.db = db;
    this.width = width;
    this.height = height;
    this.seed = seed;
  }

  /** Number of tile chunks currently loaded in memory. */
  get size(): number {
    return this.chunks.size;
  }

  /**
   * Tile kind at (x, y). The caller has already checked bounds and border;
   * unloaded chunks are generated deterministically on first read, so every
   * in-bounds coordinate has a stable answer.
   */
  tileAt(x: number, y: number): TileKind {
    const { cx, cy, lx, ly } = worldToChunk(x, y);
    const data = this.ensure(cx, cy);
    return TILE_NAMES[data[ly * CHUNK_SIZE + lx]] ?? 'grass';
  }

  /** Store a tile kind; unknown kinds are ignored (nothing to store). */
  setTile(x: number, y: number, kind: string): void {
    const numeric = TILE_KINDS[kind];
    if (numeric === undefined) return; // unknown kind: nothing to store
    const { cx, cy, lx, ly } = worldToChunk(x, y);
    const data = this.ensure(cx, cy);
    data[ly * CHUNK_SIZE + lx] = numeric;
    this.dirtyChunks.add(chunkKey(cx, cy));
  }

  /**
   * The chunk at (cx, cy), generating it deterministically on first use.
   * Freshly generated chunks with any non-grass tile are persisted to the db
   * immediately (when the world was constructed with one), so generated
   * content survives restarts and the db mirrors exactly what was explored.
   */
  ensure(cx: number, cy: number): Uint8Array {
    const key = chunkKey(cx, cy);
    let data = this.chunks.get(key);
    if (data) return data;
    data = generateChunk(this.seed, cx, cy, this.width, this.height);
    this.chunks.set(key, data);
    if (this.db && hasNonGrass(data)) saveChunk(this.db, key, data);
    return data;
  }

  /**
   * Write every dirty chunk to the db. Chunks that were dirtied but never
   * loaded cannot happen (setTile loads before it writes).
   */
  flushDirty(db: DatabaseSync): void {
    for (const key of this.dirtyChunks) {
      const data = this.chunks.get(key);
      if (data) saveChunk(db, key, data);
    }
    this.dirtyChunks.clear();
  }

  /**
   * Restore persisted chunks (see db.loadChunks). Rows that do not match the
   * current chunk layout are skipped with a warning.
   */
  load(chunks: Map<string, Uint8Array>): void {
    let loaded = 0;
    for (const [key, data] of chunks) {
      if (data.length !== CHUNK_SIZE * CHUNK_SIZE) {
        console.warn(`[world] chunk ${key}: unexpected size ${data.length} - skipping`);
        continue;
      }
      this.chunks.set(key, data);
      loaded++;
    }
    if (loaded > 0) {
      console.log(`[world] restored ${loaded} tile chunk(s)`);
    }
  }
}
