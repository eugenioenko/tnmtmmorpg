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
  'grass' | 'water' | 'mountain' | 'sand' | 'forest' | 'dirt' | 'snow' | 'swamp';

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
 * Deterministic per-chunk LCG from (seed, cx, cy) — the path generator's
 * random source. Worlds stay reproducible from the seed: no Math.random
 * anywhere, every bit of randomness flows through integer hashing.
 */
function chunkRng(seed: number, cx: number, cy: number): () => number {
  let state = (seed ^ (cx * 374761393 + cy * 668265263)) >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * Smoothing pass: a land tile whose neighbors are mostly a different kind
 * switches to match them, wiping single-tile noise so biomes read as clean
 * regions. A strict majority (half + 1 of the available in-chunk neighbors)
 * must agree, so coastlines, snow lines and chunk borders stay intact.
 * Water tiles are never smoothed into land — lakes only shrink through the
 * small-patch fill below, never through a 5v5 bay squabble.
 */
function smoothChunk(data: Uint8Array): void {
  const smoothed = new Uint8Array(data);
  const counts = new Uint8Array(8); // one slot per tile byte (0..7)
  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      counts.fill(0);
      let available = 0;
      let majority = 0;
      let majorityCount = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = lx + dx;
          const ny = ly + dy;
          if (nx < 0 || nx >= CHUNK_SIZE || ny < 0 || ny >= CHUNK_SIZE) continue;
          const kind = data[ny * CHUNK_SIZE + nx];
          counts[kind]++;
          available++;
          if (counts[kind] > majorityCount) {
            majorityCount = counts[kind];
            majority = kind;
          }
        }
      }
      const idx = ly * CHUNK_SIZE + lx;
      if (data[idx] === TILE_WATER) continue; // never smooth water into land
      const required = (available / 2 + 1) | 0;
      if (majority !== data[idx] && majorityCount >= required) {
        smoothed[idx] = majority;
      }
    }
  }
  data.set(smoothed);
}

/**
 * Small-water fill: leftover ponds — interior water regions smaller than 30
 * tiles — are filled to grass, so water appears as large connected oceans
 * and long lakes, not scattered puddles. Regions touching the chunk border
 * are left alone: they may continue into the neighboring chunk.
 */
function fillSmallWater(data: Uint8Array): void {
  const visited = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
  const queue = new Int32Array(CHUNK_SIZE * CHUNK_SIZE);
  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const start = ly * CHUNK_SIZE + lx;
      if (data[start] !== TILE_WATER || visited[start] !== 0) continue;
      // Breadth-first flood fill of this 4-connected water region.
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      visited[start] = 1;
      let touchesBorder = false;
      while (head < tail) {
        const idx = queue[head++];
        const qx = idx & (CHUNK_SIZE - 1);
        const qy = idx >> CHUNK_SHIFT;
        if (qx === 0 || qy === 0 || qx === CHUNK_SIZE - 1 || qy === CHUNK_SIZE - 1) {
          touchesBorder = true;
        }
        if (qx > 0) {
          const n = idx - 1;
          if (data[n] === TILE_WATER && visited[n] === 0) {
            visited[n] = 1;
            queue[tail++] = n;
          }
        }
        if (qx < CHUNK_SIZE - 1) {
          const n = idx + 1;
          if (data[n] === TILE_WATER && visited[n] === 0) {
            visited[n] = 1;
            queue[tail++] = n;
          }
        }
        if (qy > 0) {
          const n = idx - CHUNK_SIZE;
          if (data[n] === TILE_WATER && visited[n] === 0) {
            visited[n] = 1;
            queue[tail++] = n;
          }
        }
        if (qy < CHUNK_SIZE - 1) {
          const n = idx + CHUNK_SIZE;
          if (data[n] === TILE_WATER && visited[n] === 0) {
            visited[n] = 1;
            queue[tail++] = n;
          }
        }
      }
      if (tail < 30 && !touchesBorder) {
        for (let i = 0; i < tail; i++) data[queue[i]] = TILE_GRASS;
      }
    }
  }
}

/** Clamp a road control point back into the chunk (roads stay in-chunk). */
function clampChunk(v: number): number {
  return v < 0 ? 0 : v > CHUNK_SIZE - 1 ? CHUNK_SIZE - 1 : v;
}

/** Pave one tile as dirt road — walkable land only, never water or mountains. */
function paveTile(data: Uint8Array, x: number, y: number): void {
  const kind = data[y * CHUNK_SIZE + x];
  if (kind !== TILE_WATER && kind !== TILE_MOUNTAIN) data[y * CHUNK_SIZE + x] = TILE_DIRT;
}

/**
 * Bresenham line from a to b, paving each tile along it. Roads are 1-2
 * tiles wide: roughly a third of the steps also pave a random adjacent tile.
 */
function bresenhamRoad(
  data: Uint8Array,
  rng: () => number,
  a: { x: number; y: number },
  b: { x: number; y: number },
): void {
  let x = a.x;
  let y = a.y;
  const tx = b.x;
  const ty = b.y;
  const dx = tx - x < 0 ? -(tx - x) : tx - x;
  const dy = ty - y < 0 ? -(ty - y) : ty - y;
  const sx = x < tx ? 1 : -1;
  const sy = y < ty ? 1 : -1;
  let err = dx - dy;
  while (true) {
    paveTile(data, x, y);
    if (x === tx && y === ty) break;
    if (rng() < 0.35) {
      const dir = (rng() * 4) | 0;
      const sideX = x + (dir === 0 ? 1 : dir === 1 ? -1 : 0);
      const sideY = y + (dir === 2 ? 1 : dir === 3 ? -1 : 0);
      if (sideX >= 0 && sideX < CHUNK_SIZE && sideY >= 0 && sideY < CHUNK_SIZE) {
        paveTile(data, sideX, sideY);
      }
    }
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

/**
 * One road between two settlements: a straight-ish polyline with 1-2 bend
 * points jittered off the direct line, drawn with Bresenham. Roads only
 * pave walkable land, so they skirt lakes and mountains instead of cutting
 * through them.
 */
function drawRoadBetween(
  data: Uint8Array,
  rng: () => number,
  a: { x: number; y: number },
  b: { x: number; y: number },
): void {
  const bends = 1 + ((rng() * 2) | 0);
  const points: { x: number; y: number }[] = [{ x: a.x, y: a.y }];
  for (let i = 1; i <= bends; i++) {
    const t = i / (bends + 1);
    const px = a.x + (b.x - a.x) * t;
    const py = a.y + (b.y - a.y) * t;
    const jitter = 4;
    points.push({
      x: clampChunk((px + rng() * jitter * 2 - jitter + 0.5) | 0),
      y: clampChunk((py + rng() * jitter * 2 - jitter + 0.5) | 0),
    });
  }
  points.push({ x: b.x, y: b.y });
  for (let i = 0; i + 1 < points.length; i++) {
    bresenhamRoad(data, rng, points[i], points[i + 1]);
  }
}

/**
 * Dirt roads: every chunk picks 3-5 "settlement" points on walkable land
 * (seeded per chunk) and connects consecutive pairs with a dirt road, giving
 * the world a lived-in feel. Deterministic per chunk — the same seed always
 * draws the same roads.
 */
function drawRoads(seed: number, cx: number, cy: number, data: Uint8Array): void {
  const rng = chunkRng(seed, cx, cy);
  const settlements: { x: number; y: number }[] = [];
  const count = 3 + ((rng() * 3) | 0); // 3-5 settlements
  for (let i = 0; i < count; i++) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const x = (rng() * CHUNK_SIZE) | 0;
      const y = (rng() * CHUNK_SIZE) | 0;
      const kind = data[y * CHUNK_SIZE + x];
      if (kind === TILE_WATER || kind === TILE_MOUNTAIN) continue;
      settlements.push({ x, y });
      break;
    }
  }
  for (let i = 0; i + 1 < settlements.length; i++) {
    drawRoadBetween(data, rng, settlements[i], settlements[i + 1]);
  }
}

/**
 * Deterministic per-chunk generation from the world seed. Every tile is
 * classified from layered noise: elevation (fbm) decides ocean/beach/land/
 * peaks, latitude plus a temperature noise band decides snow, moisture
 * decides swamp/forest/scrubland/desert. Three post-passes shape the result:
 * a smoothing pass removes single-tile noise, a fill pass fills leftover
 * ponds smaller than 30 tiles, and a road pass connects 3-5 per-chunk
 * "settlements" with dirt roads. The world wraps like a torus — no borders.
 * The same seed always produces the same world; unvisited chunks are
 * generated identically on demand, so the 10000x10000 world costs memory
 * only where players go.
 */
export function generateChunk(
  seed: number,
  cx: number,
  cy: number,
  worldWidth: number,
  worldHeight: number,
): Uint8Array {
  const data = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);

  // North pole: the top rows of the map are always snow — a small guaranteed
  // polar cap, so the world reads "frozen north" even where the noise dips.
  const poleRows = (worldHeight / 200) | 0;
  const POLE_ROWS = poleRows < 2 ? 2 : poleRows;

  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const wx = cx * CHUNK_SIZE + lx;
      const wy = cy * CHUNK_SIZE + ly;

      // Larger features: lower frequency multipliers produce continent-scale
      // terrain instead of scattered noise ponds; fewer octaves soften it.
      // Elevation drives oceans, landmass and mountains; moisture separates
      // forest/swamp from scrubland and desert.
      const elevation = fbm(seed, wx * 0.002, wy * 0.002, 3);
      const moisture = fbm(seed + 5000, wx * 0.004, wy * 0.004, 3);

      // Latitude temperature (north=cold, south=hot)
      const lat = 1 - wy / (worldHeight - 1); // 1 at top, 0 at bottom
      const tempVar = fbm(seed + 10000, wx * 0.004, wy * 0.004, 2) * 0.2;
      const temperature = lat * 1.0 + tempVar;

      let kind: number;
      if (wy < POLE_ROWS) {
        // The north pole cap — always snow at the very top of the map.
        kind = TILE_SNOW;
      } else if (elevation < 0.33) {
        // Deep water — larger bodies at this lowered frequency
        kind = TILE_WATER;
      } else if (elevation < 0.43) {
        // Wide beach band at water's edge — sand is clearly visible
        kind = TILE_SAND;
      } else if (elevation > 0.74) {
        // Mountain ranges — form at high elevation
        kind = TILE_MOUNTAIN;
      } else if ((elevation > 0.66 && temperature > 0.55) || temperature > 0.62) {
        // Snowy peaks at very high elevation, or cold northern latitudes
        kind = TILE_SNOW;
      } else if (moisture < 0.28 && elevation < 0.55) {
        // Dry lowlands — small desert regions of sand
        kind = TILE_SAND;
      } else if (moisture > 0.55 && elevation < 0.5) {
        // Wet lowlands → swamp
        kind = TILE_SWAMP;
      } else if (moisture > 0.45) {
        // Moist regions → forest
        kind = TILE_FOREST;
      } else if (moisture < 0.28) {
        // Dry regions → dirt/scrubland
        kind = TILE_DIRT;
      } else {
        // Default
        kind = TILE_GRASS;
      }
      data[ly * CHUNK_SIZE + lx] = kind;
    }
  }

  // Post-passes: clean up single-tile noise, fill leftover ponds, and draw
  // dirt roads between the chunk's settlements.
  smoothChunk(data);
  fillSmallWater(data);
  drawRoads(seed, cx, cy, data);

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
