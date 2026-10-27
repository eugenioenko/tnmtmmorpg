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
  TILE_FLOOR,
  TILE_VOID,
  TILE_WALL,
  OVERWORLD,
  DEFAULT_GEN,
  DUNGEON_ENTRY,
  type GenParams,
  type WorldSpec,
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

/** Integer hash of (seed, x, y) -> uint32. Global, chunk-independent. */
function hash2(seed: number, x: number, y: number): number {
  let h = ((seed + x * 374761393 + y * 668265263) | 0) >>> 0;
  h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Floor division that behaves for negative operands (no Math). */
function floorDiv(a: number, b: number): number {
  const q = (a / b) | 0;
  return a % b !== 0 && a < 0 !== b < 0 ? q - 1 : q;
}

/**
 * Roads connect settlements on a GLOBAL lattice, not per chunk.
 *
 * Every lattice cell (gx, gy) owns one settlement whose position comes from
 * hashing the cell, so any chunk that needs it derives the identical world
 * coordinate. Each settlement links to its east and south neighbours, giving
 * one connected network spanning the map. A chunk draws every segment that
 * crosses it and clips the rest, so roads continue seamlessly over chunk
 * borders -- the previous generator clamped control points into the chunk,
 * so every 64x64 tile got its own isolated squiggle that dead-ended at the
 * seam.
 */
const ROAD_SPACING = 110;
/** Max offset of a settlement from its lattice point, in tiles. */
const ROAD_JITTER = 32;

/** World-space position of the settlement owned by lattice cell (gx, gy). */
function settlementAt(seed: number, gx: number, gy: number): { x: number; y: number } {
  const h = hash2(seed + 99991, gx, gy);
  const span = ROAD_JITTER * 2 + 1;
  return {
    x: gx * ROAD_SPACING + (h % span) - ROAD_JITTER,
    y: gy * ROAD_SPACING + (((h / span) | 0) % span) - ROAD_JITTER,
  };
}

/**
 * Pave one WORLD tile as dirt, clipped to this chunk. Walkable land only, so
 * roads skirt lakes and mountains rather than cutting through them.
 */
function paveWorld(
  data: Uint8Array,
  originX: number,
  originY: number,
  wx: number,
  wy: number,
): void {
  const lx = wx - originX;
  const ly = wy - originY;
  if (lx < 0 || ly < 0 || lx >= CHUNK_SIZE || ly >= CHUNK_SIZE) return;
  const idx = ly * CHUNK_SIZE + lx;
  const kind = data[idx];
  if (kind !== TILE_WATER && kind !== TILE_MOUNTAIN) data[idx] = TILE_DIRT;
}

/**
 * Bresenham in WORLD coordinates, paving each tile and clipping to the
 * chunk. Widening is a pure function of world position (never a per-chunk
 * RNG), so two chunks drawing the same segment agree exactly on the seam.
 */
function roadSegment(
  data: Uint8Array,
  originX: number,
  originY: number,
  seed: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): void {
  let x = ax;
  let y = ay;
  const dx = bx - x < 0 ? -(bx - x) : bx - x;
  const dy = by - y < 0 ? -(by - y) : by - y;
  const sx = x < bx ? 1 : -1;
  const sy = y < by ? 1 : -1;
  let err = dx - dy;
  let guard = 0;
  while (guard++ < 4096) {
    paveWorld(data, originX, originY, x, y);
    // Widen to 2 tiles on roughly half the steps, deterministically.
    if (hash2(seed, x, y) % 100 < 55) paveWorld(data, originX, originY, x, y + 1);
    if (x === bx && y === by) break;
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

/** One road between two settlements: two Bresenham legs via a hashed bend. */
function roadBetween(
  data: Uint8Array,
  originX: number,
  originY: number,
  seed: number,
  a: { x: number; y: number },
  b: { x: number; y: number },
): void {
  const h = hash2(seed + 4242, a.x + b.x, a.y + b.y);
  const bend = 30;
  const span = bend * 2 + 1;
  const mx = (((a.x + b.x) / 2) | 0) + (h % span) - bend;
  const my = (((a.y + b.y) / 2) | 0) + (((h / span) | 0) % span) - bend;
  roadSegment(data, originX, originY, seed, a.x, a.y, mx, my);
  roadSegment(data, originX, originY, seed, mx, my, b.x, b.y);
}

/** Draw every lattice road segment that crosses this chunk. */
function drawRoads(seed: number, cx: number, cy: number, data: Uint8Array): void {
  const originX = cx * CHUNK_SIZE;
  const originY = cy * CHUNK_SIZE;
  const g0x = floorDiv(originX, ROAD_SPACING) - 1;
  const g1x = floorDiv(originX + CHUNK_SIZE, ROAD_SPACING) + 1;
  const g0y = floorDiv(originY, ROAD_SPACING) - 1;
  const g1y = floorDiv(originY + CHUNK_SIZE, ROAD_SPACING) + 1;
  for (let gy = g0y; gy <= g1y; gy++) {
    for (let gx = g0x; gx <= g1x; gx++) {
      const here = settlementAt(seed, gx, gy);
      roadBetween(data, originX, originY, seed, here, settlementAt(seed, gx + 1, gy));
      roadBetween(data, originX, originY, seed, here, settlementAt(seed, gx, gy + 1));
    }
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
  gen: GenParams = DEFAULT_GEN,
): Uint8Array {
  const data = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);

  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const wx = cx * CHUNK_SIZE + lx;
      const wy = cy * CHUNK_SIZE + ly;

      // Larger features: these frequencies give ~50-tile landmasses and
      // water bodies. Much lower and a whole viewport falls inside a single
      // noise cell, which makes every screen one flat biome.
      const elevation = fbm(seed, wx * 0.02, wy * 0.02, 3);
      const moisture = fbm(seed + 5000, wx * 0.015, wy * 0.015, 3);

      // Climate runs on a DIAGONAL axis rather than latitude alone, so the
      // cold and hot extremes sit in known corners instead of wherever the
      // noise happens to land: 1 at the top-right (polar), 0 at the
      // bottom-left (desert). The noise term only wobbles the frontier so it
      // reads as natural rather than a ruler-straight line. The world centre
      // lands at ~0.5 -- squarely inside the temperate buffer, which is
      // where players spawn.
      const nx = wx / (worldWidth - 1);
      const ny = 1 - wy / (worldHeight - 1);
      const climate = (nx + ny) / 2 + (fbm(seed + 20000, wx * 0.008, wy * 0.008, 2) - 0.5) * 0.22;

      // The same ladder for every world; only the thresholds differ. Raising
      // gen.water floods a world, lowering gen.snow freezes it — the terrain
      // SHAPE stays identical, which is what makes the themed worlds read as
      // the same kind of place under different weather.
      let kind: number;
      if (elevation < gen.water) {
        // Deep water — oceans and long lakes
        kind = TILE_WATER;
      } else if (elevation < gen.sand) {
        // Beach band at the water's edge
        kind = TILE_SAND;
      } else if (elevation > gen.mountain) {
        // Mountain ranges
        kind = TILE_MOUNTAIN;
      } else if (climate > gen.snow) {
        // Polar region — the top-right corner of the map
        kind = TILE_SNOW;
      } else if (elevation > gen.mountain - 0.04 && climate > gen.snow - 0.16) {
        // Snow-capped shoulders below the peaks, in the cold half only
        kind = TILE_SNOW;
      } else if (climate < 0.22) {
        // Desert — the bottom-left corner of the map
        kind = TILE_SAND;
      } else if (climate < 0.34 && moisture < 0.5) {
        // Arid scrubland: the buffer between desert and temperate
        kind = TILE_DIRT;
      } else if (moisture > gen.forest + 0.1 && elevation < 0.5) {
        // Wet lowlands → swamp
        kind = TILE_SWAMP;
      } else if (moisture > gen.forest) {
        // Moist regions → forest
        kind = TILE_FOREST;
      } else if (moisture < gen.dirt) {
        // Dry regions → dirt/scrubland
        kind = TILE_DIRT;
      } else {
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
  // Last: the arrival plaza must survive every pass above it.
  stampPortalPlaza(cx, cy, worldWidth, worldHeight, data);

  return data;
}



/**
 * Tiles either side of the world centre that are guaranteed to be dry land.
 *
 * Portals arrive at the centre of every world, and the generator has no idea
 * that matters: the snow and verdant worlds both generated deep water for the
 * whole area, so travelling there put players in the middle of a lake with no
 * walkable tile in reach. They could not move, and the return pad was
 * underwater too, so it was a one-way trip into a wall.
 *
 * Six tiles clears the pad ring (which sits two out) with room to stand.
 */
const PORTAL_PLAZA_RADIUS = 6;

/**
 * Force the centre of the world to be walkable land.
 *
 * Runs last, after smoothing, pond-filling and roads, so nothing downstream
 * can flood it again. The tile written is plain grass, which every palette
 * re-skins — the plaza reads as ash in the fire world and packed snow in the
 * frozen one rather than a patch of lawn.
 */
function stampPortalPlaza(
  cx: number,
  cy: number,
  worldWidth: number,
  worldHeight: number,
  data: Uint8Array,
): void {
  const span = PORTAL_PLAZA_RADIUS * 2 + 1;
  // A world too small to hold the plaza would have it wrap onto itself and
  // pave everything; those worlds are interiors, which never come through here.
  if (worldWidth < span || worldHeight < span) return;

  const centreX = (worldWidth / 2) | 0;
  const centreY = (worldHeight / 2) | 0;
  const minX = centreX - PORTAL_PLAZA_RADIUS;
  const maxX = centreX + PORTAL_PLAZA_RADIUS;
  const minY = centreY - PORTAL_PLAZA_RADIUS;
  const maxY = centreY + PORTAL_PLAZA_RADIUS;

  // Does this chunk overlap the plaza at all? Almost never, so leave early.
  const chunkMinX = cx * CHUNK_SIZE;
  const chunkMinY = cy * CHUNK_SIZE;
  const chunkMaxX = chunkMinX + CHUNK_SIZE - 1;
  const chunkMaxY = chunkMinY + CHUNK_SIZE - 1;
  if (chunkMaxX < minX || chunkMinX > maxX || chunkMaxY < minY || chunkMinY > maxY) return;

  const fromX = minX > chunkMinX ? minX : chunkMinX;
  const toX = maxX < chunkMaxX ? maxX : chunkMaxX;
  const fromY = minY > chunkMinY ? minY : chunkMinY;
  const toY = maxY < chunkMaxY ? maxY : chunkMaxY;
  for (let wy = fromY; wy <= toY; wy++) {
    for (let wx = fromX; wx <= toX; wx++) {
      data[(wy - chunkMinY) * CHUNK_SIZE + (wx - chunkMinX)] = TILE_GRASS;
    }
  }
}

/**
 * Interior generator: a room floating in nothing.
 *
 * Unlike the terrain generator, this fills the chunk with VOID and then
 * carves floor into it, so everything outside the room renders black and
 * blocks movement. A building is a lit room in an unlit space, not a patch
 * of countryside with walls drawn on it.
 *
 * The shape is 1-3 overlapping rectangles, which is what makes rooms read as
 * built rather than generated: two overlapping rectangles give an L, three
 * give a T or a cross, and the overlap is unioned so there are never
 * interior walls cutting the space in half. Every rectangle is enclosed by a
 * WALL ring, then the ring is re-cleared wherever another rectangle's floor
 * runs through it — otherwise the wings would be walled off from each other.
 *
 * Deterministic from the seed, which is derived from the door's position, so
 * the same door always opens onto the same room and nothing has to be stored.
 */
export function generateRooms(
  seed: number,
  cx: number,
  cy: number,
  worldWidth: number,
  worldHeight: number,
): Uint8Array {
  const data = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
  data.fill(TILE_VOID);

  // Interiors are one chunk; anything past the world's own size is void.
  if (cx !== 0 || cy !== 0) return data;

  // Small deterministic LCG; Math.random is banned by lint and would break
  // the guarantee that a door always opens onto the same room.
  let state = seed >>> 0 || 1;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const between = (lo: number, hi: number): number => lo + ~~(next() * (hi - lo + 1));

  const limit = worldWidth < CHUNK_SIZE ? worldWidth : CHUNK_SIZE;
  const limitY = worldHeight < CHUNK_SIZE ? worldHeight : CHUNK_SIZE;

  interface Rect {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  }
  const rects: Rect[] = [];

  // The main hall, roughly centred so the arrival tile is always inside it.
  const mainW = between(10, 18);
  const mainH = between(8, 14);
  const mainX = ~~((limit - mainW) / 2);
  const mainY = ~~((limitY - mainH) / 2);
  rects.push({ x0: mainX, y0: mainY, x1: mainX + mainW - 1, y1: mainY + mainH - 1 });

  // Wings, each overlapping the hall so the union stays one connected space.
  const wings = between(0, 2);
  for (let i = 0; i < wings; i++) {
    const w = between(6, 12);
    const h = between(5, 10);
    const horizontal = next() < 0.5;
    let x0: number;
    let y0: number;
    if (horizontal) {
      x0 = next() < 0.5 ? mainX - w + 2 : mainX + mainW - 2;
      y0 = mainY + between(0, mainH > h ? mainH - h : 0);
    } else {
      x0 = mainX + between(0, mainW > w ? mainW - w : 0);
      y0 = next() < 0.5 ? mainY - h + 2 : mainY + mainH - 2;
    }
    // Keep a 1-tile margin so the wall ring always fits inside the chunk.
    if (x0 < 1) x0 = 1;
    if (y0 < 1) y0 = 1;
    if (x0 + w > limit - 1) x0 = limit - 1 - w;
    if (y0 + h > limitY - 1) y0 = limitY - 1 - h;
    if (x0 < 1 || y0 < 1) continue;
    rects.push({ x0, y0, x1: x0 + w - 1, y1: y0 + h - 1 });
  }

  const put = (x: number, y: number, kind: number): void => {
    if (x < 0 || y < 0 || x >= CHUNK_SIZE || y >= CHUNK_SIZE) return;
    data[y * CHUNK_SIZE + x] = kind;
  };
  const at = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= CHUNK_SIZE || y >= CHUNK_SIZE) return TILE_VOID;
    return data[y * CHUNK_SIZE + x];
  };

  // Walls first, then floor over the top: any wall that falls inside another
  // rectangle's floor is overwritten, which is what joins the wings.
  for (const r of rects) {
    for (let x = r.x0 - 1; x <= r.x1 + 1; x++) {
      put(x, r.y0 - 1, TILE_WALL);
      put(x, r.y1 + 1, TILE_WALL);
    }
    for (let y = r.y0 - 1; y <= r.y1 + 1; y++) {
      put(r.x0 - 1, y, TILE_WALL);
      put(r.x1 + 1, y, TILE_WALL);
    }
  }
  for (const r of rects) {
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) put(x, y, TILE_FLOOR);
    }
  }

  // Any wall with no floor beside it is a leftover from an overlap and would
  // read as a stray block hanging in the void; return it to void.
  for (let y = 0; y < CHUNK_SIZE; y++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      if (at(x, y) !== TILE_WALL) continue;
      let touchesFloor = false;
      for (let dy = -1; dy <= 1 && !touchesFloor; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (at(x + dx, y + dy) === TILE_FLOOR) {
            touchesFloor = true;
            break;
          }
        }
      }
      if (!touchesFloor) put(x, y, TILE_VOID);
    }
  }

  return data;
}

/**
 * Cave generator: a dungeon carved out of rock.
 *
 * An entrance chamber on the west edge (always containing DUNGEON_ENTRY,
 * where arrivals land) leads through a chain of chambers eastward to a
 * large final hall, with a dead-end side room or two hanging off the chain.
 * Chambers have ragged edges and the tunnels between them are two tiles
 * wide, so it reads as dug rather than built. Every floor tile touching
 * void becomes WALL, which the client draws as rock.
 *
 * Deterministic from the seed (which comes from the entrance position), so
 * every copy of a cave has the same layout and nothing is stored.
 */
export function generateCaves(seed: number, cx: number, cy: number): Uint8Array {
  const data = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
  data.fill(TILE_VOID);
  if (cx !== 0 || cy !== 0) return data;

  let state = seed >>> 0 || 1;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const between = (lo: number, hi: number): number => lo + ~~(next() * (hi - lo + 1));
  const max = CHUNK_SIZE - 2;

  const carve = (x: number, y: number): void => {
    if (x < 1 || y < 1 || x > max || y > max) return;
    data[y * CHUNK_SIZE + x] = TILE_FLOOR;
  };
  const isFloor = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < CHUNK_SIZE && y < CHUNK_SIZE && data[y * CHUNK_SIZE + x] === TILE_FLOOR;

  interface Room {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  }
  const centre = (r: Room): { x: number; y: number } => ({ x: (r.x0 + r.x1) >> 1, y: (r.y0 + r.y1) >> 1 });

  const room = (r: Room): void => {
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) carve(x, y);
    // Ragged edges: bite into the rock around the rectangle here and there.
    for (let x = r.x0; x <= r.x1; x++) {
      if (next() < 0.4) carve(x, r.y0 - 1);
      if (next() < 0.4) carve(x, r.y1 + 1);
    }
    for (let y = r.y0; y <= r.y1; y++) {
      if (next() < 0.4) carve(r.x0 - 1, y);
      if (next() < 0.4) carve(r.x1 + 1, y);
    }
  };

  /** A two-wide tunnel: along x first or y first, with the odd kink. */
  const tunnel = (a: { x: number; y: number }, b: { x: number; y: number }): void => {
    let x = a.x;
    let y = a.y;
    const xFirst = next() < 0.5;
    const stepX = (): void => {
      while (x !== b.x) {
        x += x < b.x ? 1 : -1;
        if (next() < 0.12) y += next() < 0.5 ? 1 : -1;
        if (y < 2) y = 2;
        if (y > max - 1) y = max - 1;
        carve(x, y);
        carve(x, y + 1);
      }
    };
    const stepY = (): void => {
      while (y !== b.y) {
        y += y < b.y ? 1 : -1;
        carve(x, y);
        carve(x + 1, y);
      }
    };
    if (xFirst) {
      stepX();
      stepY();
    } else {
      stepY();
      stepX();
    }
  };

  const entrance: Room = {
    x0: DUNGEON_ENTRY.x - 4,
    y0: DUNGEON_ENTRY.y - 4,
    x1: DUNGEON_ENTRY.x + 4,
    y1: DUNGEON_ENTRY.y + 4,
  };
  const chain: Room[] = [entrance];
  const count = between(4, 6);
  const span = (max - 2 - (entrance.x1 + 3)) / count;
  for (let i = 0; i < count; i++) {
    const last = i === count - 1;
    const w = last ? between(13, 15) : between(7, 11);
    const h = last ? between(11, 13) : between(6, 10);
    let x0 = entrance.x1 + 3 + ~~(span * i) + between(0, 2);
    if (x0 + w > max - 1) x0 = max - 1 - w;
    const y0 = between(3, max - 1 - h);
    chain.push({ x0, y0, x1: x0 + w - 1, y1: y0 + h - 1 });
  }
  for (const r of chain) room(r);
  for (let i = 1; i < chain.length; i++) tunnel(centre(chain[i - 1]), centre(chain[i]));

  const sides = between(1, 2);
  for (let i = 0; i < sides; i++) {
    const from = chain[between(1, chain.length - 2)];
    const w = between(5, 7);
    const h = between(4, 6);
    const above = from.y0 > CHUNK_SIZE - from.y1;
    let y0 = above ? from.y0 - h - between(4, 7) : from.y1 + between(4, 7);
    if (y0 < 3) y0 = 3;
    if (y0 + h > max - 1) y0 = max - 1 - h;
    let x0 = from.x0 + between(-2, 2);
    if (x0 < 3) x0 = 3;
    if (x0 + w > max - 1) x0 = max - 1 - w;
    const side: Room = { x0, y0, x1: x0 + w - 1, y1: y0 + h - 1 };
    room(side);
    tunnel(centre(from), centre(side));
  }

  for (let y = 0; y < CHUNK_SIZE; y++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      if (data[y * CHUNK_SIZE + x] !== TILE_VOID) continue;
      let edge = false;
      for (let dy = -1; dy <= 1 && !edge; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (isFloor(x + dx, y + dy)) {
            edge = true;
            break;
          }
        }
      }
      if (edge) data[y * CHUNK_SIZE + x] = TILE_WALL;
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
  /** Chunks generated since the last drainFresh(); awaiting feature decoration. */
  private fresh: { cx: number; cy: number }[] = [];
  /** When present, freshly generated non-grass chunks are persisted immediately. */
  private readonly db: DatabaseSync | undefined;
  private readonly width: number;
  private readonly height: number;
  private readonly seed: number;
  /** Which world this store holds; decides the generator and the db key. */
  private readonly spec: WorldSpec;

  constructor(db: DatabaseSync | undefined, spec: WorldSpec) {
    this.db = db;
    this.spec = spec;
    this.width = spec.width;
    this.height = spec.height;
    this.seed = spec.seed;
  }

  /**
   * The db row key for a chunk of THIS world.
   *
   * The overworld deliberately keeps the bare 'cx,cy' form it has always
   * used, so every chunk row written before worlds existed still loads and
   * no player's terrain edits are lost. Only other worlds carry a prefix.
   * That is the whole migration — there isn't one.
   */
  private storageKey(cx: number, cy: number): string {
    const key = chunkKey(cx, cy);
    return this.spec.id === OVERWORLD ? key : `${this.spec.id}:${key}`;
  }

  /** Inverse of storageKey: the local key, or undefined if another world's. */
  private localKey(storage: string): string | undefined {
    const colon = storage.lastIndexOf(':');
    if (this.spec.id === OVERWORLD) return colon < 0 ? storage : undefined;
    if (colon < 0) return undefined;
    return storage.slice(0, colon) === this.spec.id ? storage.slice(colon + 1) : undefined;
  }

  /** This world's generator, chosen by its spec. */
  private generate(cx: number, cy: number): Uint8Array {
    if (this.spec.generator === 'rooms') {
      return generateRooms(this.seed, cx, cy, this.width, this.height);
    }
    if (this.spec.generator === 'caves') return generateCaves(this.seed, cx, cy);
    return generateChunk(this.seed, cx, cy, this.width, this.height, this.spec.gen);
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
   *
   * A freshly generated chunk is persisted immediately (when the world has a
   * db), unconditionally. The persist used to be gated on the chunk holding
   * a non-grass tile, but that gate is what makes "is it in the db" mean
   * "has it been generated before" — and that equivalence is exactly what
   * keeps chunk decoration one-shot across restarts. An all-grass chunk
   * would otherwise regenerate on every boot and be decorated again, growing
   * a fresh crop of trees each time. In practice the gate never fired
   * anyway: with biomes and roads, 0 of 256 sampled chunks were pure grass.
   *
   * Newly generated chunks are recorded in `fresh` rather than decorated
   * here: this runs on the read path (snapshot building calls world.tile()),
   * and spawning entities mid-read would mutate the store while it is being
   * serialised. The tick loop drains them at a safe boundary.
   */
  ensure(cx: number, cy: number): Uint8Array {
    const key = chunkKey(cx, cy);
    let data = this.chunks.get(key);
    if (data) return data;
    data = this.generate(cx, cy);
    this.chunks.set(key, data);
    if (this.db) saveChunk(this.db, this.storageKey(cx, cy), data);
    this.fresh.push({ cx, cy });
    return data;
  }

  /**
   * Chunk coords generated since the last call, and clears the list. Chunks
   * restored from the db never appear here, so a decorator sees each chunk
   * exactly once in the world's lifetime.
   */
  drainFresh(): { cx: number; cy: number }[] {
    if (this.fresh.length === 0) return [];
    const out = this.fresh;
    this.fresh = [];
    return out;
  }

  /** Offer already-loaded chunks (e.g. restored from the db) as candidates. */
  offerForDecoration(keys: Iterable<string>): void {
    for (const key of keys) {
      const comma = key.indexOf(',');
      if (comma < 0) continue;
      this.fresh.push({ cx: Number(key.slice(0, comma)), cy: Number(key.slice(comma + 1)) });
    }
  }

  /**
   * Write every dirty chunk to the db. Chunks that were dirtied but never
   * loaded cannot happen (setTile loads before it writes).
   */
  flushDirty(db: DatabaseSync): void {
    for (const key of this.dirtyChunks) {
      const data = this.chunks.get(key);
      if (!data) continue;
      const comma = key.indexOf(',');
      const cx = Number(key.slice(0, comma));
      const cy = Number(key.slice(comma + 1));
      saveChunk(db, this.storageKey(cx, cy), data);
    }
    this.dirtyChunks.clear();
  }

  /**
   * Restore persisted chunks (see db.loadChunks). Rows that do not match the
   * current chunk layout are skipped with a warning.
   */
  load(chunks: Map<string, Uint8Array>): void {
    let loaded = 0;
    for (const [storage, data] of chunks) {
      // Every world is offered every row; take only our own.
      const key = this.localKey(storage);
      if (key === undefined) continue;
      if (data.length !== CHUNK_SIZE * CHUNK_SIZE) {
        console.warn(`[world] chunk ${storage}: unexpected size ${data.length} - skipping`);
        continue;
      }
      this.chunks.set(key, data);
      loaded++;
    }
    if (loaded > 0) {
      console.log(`[world] ${this.spec.id}: restored ${loaded} tile chunk(s)`);
    }
  }
}
