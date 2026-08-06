import { Graphics } from 'pixi.js';
import {
  OVERWORLD,
  TILE_BYTE_BY_KIND,
  TILE_GRASS,
  TILE_SIZE,
  TILE_VOID,
  VIEW_HALO,
  paletteColor,
  resolveWorld,
} from '@game/shared';

// TILE_SIZE and the view radii live in @game/shared so the client can never
// draw a different amount of world than the server sends.
export { TILE_SIZE } from '@game/shared';

/** Half a tile; the diagonal edge cuts pivot on the tile edge midpoints. */
const HALF = TILE_SIZE / 2;

/**
 * The corner triangle for each mask bit, in tile-local coordinates. When the
 * majority terrain at a corner differs from the tile's own terrain, the tile
 * renders as its full square with this triangle repainted in the corner's
 * terrain color — the diagonal shorelines come from these cuts.
 *
 * Bit 0 (1): TL corner   Bit 1 (2): TR corner
 * Bit 2 (4): BR corner   Bit 3 (8): BL corner
 */
const CORNER_TRIANGLES: Record<number, [number, number, number, number, number, number]> = {
  1: [0, 0, HALF, 0, 0, HALF], // TL: (0,0) - (H,0) - (0,H)
  2: [TILE_SIZE, 0, TILE_SIZE, HALF, HALF, 0], // TR: (S,0) - (S,H) - (H,0)
  4: [TILE_SIZE, TILE_SIZE, TILE_SIZE, HALF, HALF, TILE_SIZE], // BR: (S,S) - (S,H) - (H,S)
  8: [0, TILE_SIZE, HALF, TILE_SIZE, 0, HALF], // BL: (0,S) - (H,S) - (0,H)
};

const CORNER_BITS = [1, 2, 4, 8] as const;

/**
 * Compute corner mask for a tile.
 * Bit 0 (1): TL corner differs
 * Bit 1 (2): TR corner differs
 * Bit 2 (4): BR corner differs
 * Bit 3 (8): BL corner differs
 *
 * A corner "differs" if the majority of tiles at that corner
 * are a different terrain type than this tile.
 */
function cornerMask(grid: (x: number, y: number) => number, tx: number, ty: number): number {
  const center = grid(tx, ty);
  let mask = 0;

  // TL corner: tiles at (tx,ty), (tx-1,ty), (tx-1,ty-1), (tx,ty-1)
  {
    const same =
      (grid(tx - 1, ty - 1) === center ? 1 : 0) +
      (grid(tx, ty - 1) === center ? 1 : 0) +
      (grid(tx - 1, ty) === center ? 1 : 0) +
      (grid(tx, ty) === center ? 1 : 0);
    // "same < 2" = a strict majority (3+) of the corner's tiles differ.
    // A 2v2 tie counts as "same": neither side cuts, so axis-aligned
    // boundaries stay clean straight lines instead of tearing.
    if (same < 2) mask |= 1; // minority same → corner is "different"
  }
  // TR corner
  {
    const same =
      (grid(tx, ty - 1) === center ? 1 : 0) +
      (grid(tx + 1, ty - 1) === center ? 1 : 0) +
      (grid(tx, ty) === center ? 1 : 0) +
      (grid(tx + 1, ty) === center ? 1 : 0);
    if (same < 2) mask |= 2;
  }
  // BR corner
  {
    const same =
      (grid(tx, ty) === center ? 1 : 0) +
      (grid(tx + 1, ty) === center ? 1 : 0) +
      (grid(tx, ty + 1) === center ? 1 : 0) +
      (grid(tx + 1, ty + 1) === center ? 1 : 0);
    if (same < 2) mask |= 4;
  }
  // BL corner
  {
    const same =
      (grid(tx - 1, ty) === center ? 1 : 0) +
      (grid(tx, ty) === center ? 1 : 0) +
      (grid(tx - 1, ty + 1) === center ? 1 : 0) +
      (grid(tx, ty + 1) === center ? 1 : 0);
    if (same < 2) mask |= 8;
  }

  return mask;
}

/**
 * The majority terrain at one of the tile's corners, for coloring the cut
 * triangle. Only called when the mask bit is set, so the majority is a
 * strict one (3 or 4 of the 4 tiles share it); any differing tile works.
 */
function cornerTerrain(
  grid: (x: number, y: number) => number,
  tx: number,
  ty: number,
  bit: number,
): number {
  const center = grid(tx, ty);
  switch (bit) {
    case 1:
      for (const [dx, dy] of [
        [-1, -1],
        [0, -1],
        [-1, 0],
      ]) {
        const t = grid(tx + dx, ty + dy);
        if (t !== center) return t;
      }
      break;
    case 2:
      for (const [dx, dy] of [
        [0, -1],
        [1, -1],
        [1, 0],
      ]) {
        const t = grid(tx + dx, ty + dy);
        if (t !== center) return t;
      }
      break;
    case 4:
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
        [1, 1],
      ]) {
        const t = grid(tx + dx, ty + dy);
        if (t !== center) return t;
      }
      break;
    case 8:
      for (const [dx, dy] of [
        [-1, 0],
        [-1, 1],
        [0, 1],
      ]) {
        const t = grid(tx + dx, ty + dy);
        if (t !== center) return t;
      }
      break;
  }
  return center;
}

/**
 * Renders the tile layer from the local world model's known-tiles map. The
 * map is sparse — only non-grass tiles the server told us about; anything
 * else is grass — so the visible range is drawn as grass squares first and
 * the known tiles' squares and diagonal edge cuts overlay them.
 *
 * Every visible tile renders as its full square plus up to one corner-cut
 * triangle per corner whose majority terrain differs (see cornerMask), which
 * turns terrain transitions into smooth diagonal shorelines.
 */
export class TilemapRenderer {
  // Last-drawn tilemap extent (the base follows the camera).
  private tilesKey = '';
  /** The world being drawn, and the palette it selects. */
  private world = OVERWORLD;
  private palette = 'overworld';
  private minX = 0;
  private maxX = 0;
  private minY = 0;
  private maxY = 0;
  private readonly layer: Graphics;
  /** Scratch buffer for the decoded visible range; grown on demand, reused. */
  private buf = new Uint8Array(0);

  constructor(layer: Graphics) {
    this.layer = layer;
  }

  /**
   * Redraw the tilemap only when its contents or the camera position
   * changed. `tiles` is the world model's known-tiles map ('x,y' → kind);
   * the camera centre is the point the view is centred on (world px), and
   * the viewport is in CSS pixels.
   */
  /**
   * Which world is being drawn. Only the palette depends on it — tiles are
   * the same bytes everywhere, so the fire world is the overworld's terrain
   * in magma rather than a different format.
   */
  setWorld(world: string): void {
    if (world === this.world) return;
    this.world = world;
    this.palette = resolveWorld(world)?.palette ?? 'overworld';
    // Force the next rebuild: the tile SET may be identical while every
    // colour changed, and the change hash would not notice.
    this.tilesKey = '';
  }

  rebuild(
    tiles: ReadonlyMap<string, string>,
    cameraCenterX: number,
    cameraCenterY: number,
    viewW: number,
    viewH: number,
  ): void {
    // The drawn range must cover the camera view; the +1 halo is so the
    // corner sampling (which reads one tile out) stays inside drawn ground.
    const halfX = ~~(viewW / (2 * TILE_SIZE)) + VIEW_HALO;
    const halfY = ~~(viewH / (2 * TILE_SIZE)) + VIEW_HALO;
    const minX = ~~(cameraCenterX / TILE_SIZE) - halfX;
    const maxX = ~~(cameraCenterX / TILE_SIZE) + halfX;
    const minY = ~~(cameraCenterY / TILE_SIZE) - halfY;
    const maxY = ~~(cameraCenterY / TILE_SIZE) + halfY;

    // The drawn range is the camera viewport and nothing more. It must never
    // be widened to cover the known-tiles map: those are absolute world
    // coordinates (~5000,5000), while the camera reads (0,0) until the local
    // player's entity arrives. Spanning the two produced a ~25M-cell
    // rectangle on the first frame, which hung the GPU process.
    // Tiles outside the viewport are not visible, so they are simply clipped.

    // Decode the visible range (plus a 1-tile halo, since corner sampling
    // reads one tile out) into a flat byte buffer ONCE. The corner mask does
    // 16 grid() reads per cell and cornerTerrain several more; going straight
    // to the tiles map would build a `${x},${y}` key on every one of those —
    // ~20k string allocations per rebuild. This is ~1.2k instead, and every
    // later read is a plain array index.
    const bufW = maxX - minX + 3;
    const bufH = maxY - minY + 3;
    if (this.buf.length < bufW * bufH) this.buf = new Uint8Array(bufW * bufH);
    const buf = this.buf;

    // Change detection folded into the same pass, as a rolling FNV-1a hash
    // (no allocation, unlike joining a ~2400-entry string every frame).
    let hash = 2166136261;
    hash = ((hash ^ minX) * 16777619) >>> 0;
    hash = ((hash ^ minY) * 16777619) >>> 0;
    hash = ((hash ^ maxX) * 16777619) >>> 0;
    hash = ((hash ^ maxY) * 16777619) >>> 0;
    for (let y = minY - 1; y <= maxY + 1; y++) {
      const row = (y - minY + 1) * bufW;
      for (let x = minX - 1; x <= maxX + 1; x++) {
        // Ground the server never mentioned. Outdoors that means grass (the
        // server omits it to save bandwidth); inside a building it means
        // void, because there "not sent" is "not carved".
        const fallback = this.palette === 'interior' ? TILE_VOID : TILE_GRASS;
        const kind = tiles.get(`${x},${y}`);
        const byte = kind === undefined ? fallback : (TILE_BYTE_BY_KIND[kind] ?? fallback);
        buf[row + (x - minX + 1)] = byte;
        if (byte !== TILE_GRASS) hash = ((hash ^ (x * 31 + y)) * 16777619 + byte) >>> 0;
      }
    }
    const key = String(hash);
    if (
      key === this.tilesKey &&
      minX === this.minX &&
      maxX === this.maxX &&
      minY === this.minY &&
      maxY === this.maxY
    ) {
      return;
    }
    this.tilesKey = key;
    this.minX = minX;
    this.maxX = maxX;
    this.minY = minY;
    this.maxY = maxY;
    this.layer.clear();

    // Terrain byte for a world tile, read from the decoded buffer above.
    // Anything outside the halo (never sampled) reads as grass.
    const grid = (x: number, y: number): number => {
      const bx = x - minX + 1;
      const by = y - minY + 1;
      if (bx < 0 || by < 0 || bx >= bufW || by >= bufH) return TILE_GRASS;
      return buf[by * bufW + bx];
    };

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const byte = grid(x, y);
        const color = paletteColor(this.palette, byte);
        const ox = x * TILE_SIZE;
        const oy = y * TILE_SIZE;

        // The tile's full square, then the diagonal edge cuts.
        this.layer.rect(ox, oy, TILE_SIZE, TILE_SIZE).fill(color);

        const mask = cornerMask(grid, x, y);
        if (mask === 0) continue;
        for (const bit of CORNER_BITS) {
          if ((mask & bit) === 0) continue;
          const foreign = paletteColor(this.palette, cornerTerrain(grid, x, y, bit));
          const tri = CORNER_TRIANGLES[bit];
          this.layer
            .poly([ox + tri[0], oy + tri[1], ox + tri[2], oy + tri[3], ox + tri[4], oy + tri[5]])
            .fill(foreign);
        }
      }
    }
  }
}
