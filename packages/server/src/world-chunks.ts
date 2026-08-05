import type { DatabaseSync } from 'node:sqlite';
import {
  TILE_BYTE_BY_KIND,
  TILE_DIRT,
  TILE_FOREST,
  TILE_GRASS,
  TILE_MOUNTAIN,
  TILE_NAMES,
  TILE_SAND,
  TILE_SNOW,
  TILE_SWAMP,
  TILE_WATER,
} from '@game/shared';
import { saveChunk } from './db.ts';

// Re-exported so world.ts's re-export chain keeps working unchanged.
export {
  TILE_DIRT,
  TILE_FOREST,
  TILE_GRASS,
  TILE_MOUNTAIN,
  TILE_NAMES,
  TILE_SAND,
  TILE_SNOW,
  TILE_SWAMP,
  TILE_WATER,
} from '@game/shared';

/** The 8 terrain kinds the noise generator can produce. */
export type TileKind =
  | 'grass'
  | 'water'
  | 'mountain'
  | 'sand'
  | 'forest'
  | 'dirt'
  | 'snow'
  | 'swamp';

/** Chunk edge in tiles; each chunk stores CHUNK_SIZE x CHUNK_SIZE tiles. */
export const CHUNK_SIZE = 64;
/** log2(CHUNK_SIZE); a chunk coord is a world coord shifted right by this. */
export const CHUNK_SHIFT = 6;

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

/**
 * Seeded value noise at arbitrary coordinates.
 * Returns 0-1. Uses smoothstep interpolation between hashed grid points.
 * No Math: everything flows through integer hashing, so worlds are
 * reproducible from a seed.
 */
function valueNoise(seed: number, x: number, y: number): number {
  const x0 = x | 0;
  const y0 = y | 0;
  const x1 = x0 + 1;
  const y1 = y0 + 1;

  // Smoothstep
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);

  // Hash grid points (LCG-based, no Math)
  const hash = (cx: number, cy: number): number => {
    let h = ((seed + cx * 374761393 + cy * 668265263) | 0) >>> 0;
    h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296; // 0 to 1
  };

  const n00 = hash(x0, y0);
  const n10 = hash(x1, y0);
  const n01 = hash(x0, y1);
  const n11 = hash(x1, y1);

  // Bilinear interpolation
  const ix0 = n00 + (n10 - n00) * sx;
  const ix1 = n01 + (n11 - n01) * sx;
  return ix0 + (ix1 - ix0) * sy;
}

/**
 * Fractal Brownian Motion — multiple noise octaves.
 */
function fbm(seed: number, x: number, y: number, octaves: number): number {
  let value = 0;
  let amp = 1;
  let freq = 1;
  let max = 0;
  for (let i = 0; i < octaves; i++) {
    value += valueNoise(seed + i * 7919, x * freq, y * freq) * amp;
    max += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return value / max;
}

/** True when the chunk holds any non-grass tile. */
function hasNonGrass(data: Uint8Array): boolean {
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== TILE_GRASS) return true;
  }
  return false;
}

/**
 * Deterministic per-chunk generation from the world seed. Every tile is
 * classified from layered noise: elevation (fbm) decides ocean/beach/land/
 * peaks, latitude plus a temperature noise band decides snow, moisture
 * decides swamp/forest/scrubland. The world wraps like a torus — no borders. The same seed
 * always produces the same world; unvisited chunks are generated identically
 * on demand, so the 10000x10000 world costs memory only where players go.
 */
export function generateChunk(
  seed: number,
  cx: number,
  cy: number,
  worldWidth: number,
  worldHeight: number,
): Uint8Array {
  const data = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);

  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const wx = cx * CHUNK_SIZE + lx;
      const wy = cy * CHUNK_SIZE + ly;

// Larger features: lower frequency multipliers produce continent-scale
      // terrain instead of scattered noise ponds.  Elevation drives oceans,
      // landmass and mountains; moisture separates forest/swamp from scrubland.
      const elevation = fbm(seed, wx * 0.006, wy * 0.006, 4);
      const moisture = fbm(seed + 5000, wx * 0.005, wy * 0.005, 3);

      // Latitude temperature (north=cold, south=hot)
      const lat = 1 - wy / (worldHeight - 1); // 1 at top, 0 at bottom
      const tempVar = fbm(seed + 10000, wx * 0.004, wy * 0.004, 2) * 0.2;
      const temperature = lat * 1.0 + tempVar;

      // Deep water — larger bodies at this lowered frequency
      if (elevation < 0.33) {
        data[ly * CHUNK_SIZE + lx] = TILE_WATER;
        continue;
      }
      // Narrow beach band at water's edge
      if (elevation < 0.38) {
        data[ly * CHUNK_SIZE + lx] = TILE_SAND;
        continue;
      }
      // Mountain ranges — form at high elevation
      if (elevation > 0.74) {
        data[ly * CHUNK_SIZE + lx] = TILE_MOUNTAIN;
        continue;
      }
      // Snowy peaks at very high elevation, or cold northern latitudes
      if ((elevation > 0.66 && temperature > 0.55) || temperature > 0.70) {
        data[ly * CHUNK_SIZE + lx] = TILE_SNOW;
        continue;
      }
      // Wet lowlands → swamp
      if (moisture > 0.55 && elevation < 0.50) {
        data[ly * CHUNK_SIZE + lx] = TILE_SWAMP;
        continue;
      }
      // Moist regions → forest
      if (moisture > 0.45) {
        data[ly * CHUNK_SIZE + lx] = TILE_FOREST;
        continue;
      }
      // Dry regions → dirt/scrubland
      if (moisture < 0.28) {
        data[ly * CHUNK_SIZE + lx] = TILE_DIRT;
        continue;
      }
      // Default
      data[ly * CHUNK_SIZE + lx] = TILE_GRASS;
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
    return (TILE_NAMES[data[ly * CHUNK_SIZE + lx]] ?? 'grass') as TileKind;
  }

  /**
   * The raw tile byte at (x, y) without generating the chunk: `undefined`
   * when the chunk has never been loaded. Callers that must not touch the
   * world (walkability probes on unvisited areas) fall back to grass.
   */
  getChunk(cx: number, cy: number): Uint8Array | undefined {
    return this.chunks.get(chunkKey(cx, cy));
  }

  /** Store a tile kind; unknown kinds are ignored (nothing to store). */
  setTile(x: number, y: number, kind: string): void {
    const numeric = TILE_BYTE_BY_KIND[kind];
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
