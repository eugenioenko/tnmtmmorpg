import { Graphics, Matrix, type FillStyle, type Texture } from 'pixi.js';
import {
  OVERWORLD,
  TILE_BYTE_BY_KIND,
  TILE_DIRT,
  TILE_FLOOR,
  TILE_GRASS,
  TILE_MOUNTAIN,
  TILE_BRIDGE,
  TILE_SIZE,
  TILE_VOID,
  TILE_WALL,
  isCarvedWorld,
  VIEW_HALO,
  paletteColor,
  resolveWorld,
} from '@game/shared';
import { artTexture, terrainTexture, transitionTexture } from '../art.ts';

// TILE_SIZE and the view radii live in @game/shared so the client can never
// draw a different amount of world than the server sends.
export { TILE_SIZE } from '@game/shared';

// N, E, S, W, then the four diagonals. Bits match the atlas edge masks.
const NEIGHBOURS = [
  [0, -1, 1],
  [1, 0, 2],
  [0, 1, 4],
  [-1, 0, 8],
  [-1, -1, 16],
  [1, -1, 32],
  [1, 1, 64],
  [-1, 1, 128],
] as const;
// Higher layers feather into lower ones. Water remains below every shoreline.
const PRIORITY = [5, 0, 1, 3, 6, 4, 7, 2];
const BIOME_TINT: Record<number, number> = { 3: 0xffe1a0, 4: 0x8bba73, 7: 0x70875c };

/**
 * Renders the tile layer from the local world model's known-tiles map. The
 * map is sparse — only non-grass tiles the server told us about; anything
 * else is grass — so the visible range is drawn as grass squares first and
 * the known tiles' squares and diagonal edge cuts overlay them.
 *
 * Adjacent biomes join through eight-neighbour textured fringes and rounded
 * corners, with a thin shoreline rim where land meets water. All transitions
 * share the same source atlas as terrain and entities.
 */
export class TilemapRenderer {
  // Last-drawn tilemap extent (the base follows the camera).
  private tilesKey = '';
  /** The world being drawn, and the palette it selects. */
  private world = OVERWORLD;
  private palette = 'overworld';
  /** Interiors and caves: ground the server never sent is void, not grass. */
  private carved = false;
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
    const spec = resolveWorld(world);
    this.palette = spec?.palette ?? 'overworld';
    this.carved = isCarvedWorld(spec);
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
    // transition sampling (which reads one tile out) stays inside drawn ground.
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

    // Decode the visible range and a one-tile halo once. Eight-neighbour
    // transitions then read byte indices instead of allocating map keys for
    // every neighbour of every visible tile.
    const bufW = maxX - minX + 3;
    const bufH = maxY - minY + 3;
    if (this.buf.length < bufW * bufH) this.buf = new Uint8Array(bufW * bufH);
    const buf = this.buf;

    // Change detection folded into the same pass, as a rolling FNV-1a hash
    // (no allocation, unlike joining a ~2400-entry string every frame).
    let hash = 2166136261;
    const phase = ~~(performance.now() / 220) % 4;
    let hasWater = false;
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
        const fallback = this.carved ? TILE_VOID : TILE_GRASS;
        const kind = tiles.get(`${x},${y}`);
        const byte = kind === undefined ? fallback : (TILE_BYTE_BY_KIND[kind] ?? fallback);
        buf[row + (x - minX + 1)] = byte;
        if (byte === 1) hasWater = true;
        if (byte !== TILE_GRASS) hash = ((hash ^ (x * 31 + y)) * 16777619 + byte) >>> 0;
      }
    }
    const key = `${hash}:${hasWater ? phase : 0}`;
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

    const fill = (
      byte: number,
      ox: number,
      oy: number,
      texture: Texture | undefined = terrainTexture(byte, byte === 1 ? phase : 0),
    ): FillStyle | number => {
      const cave = this.palette === 'cave';
      if (cave && byte === TILE_FLOOR) texture = terrainTexture(TILE_DIRT);
      if (cave && byte === TILE_WALL) texture = terrainTexture(TILE_MOUNTAIN);
      const exteriorWall = byte === TILE_WALL && this.palette !== 'interior' && !cave;
      if (exteriorWall) texture = terrainTexture(TILE_DIRT);
      if (!texture) return paletteColor(this.palette, byte);
      // Preserve the distinctive colors of themed worlds; the overworld uses
      // the extracted palette, with a few biome-specific color adjustments.
      const color = exteriorWall
        ? 0x756351
        : cave
          ? paletteColor(this.palette, byte)
          : this.palette === 'overworld' || this.palette === 'interior'
          ? (BIOME_TINT[byte] ?? 0xffffff)
          : paletteColor(this.palette, byte);
      return {
        texture,
        color,
        textureSpace: 'global',
        matrix: new Matrix()
          .scale(TILE_SIZE / texture.width, TILE_SIZE / texture.height)
          .translate(ox, oy),
      };
    };

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const byte = grid(x, y);
        const ox = x * TILE_SIZE;
        const oy = y * TILE_SIZE;

        if (byte === TILE_BRIDGE) {
          this.layer.rect(ox, oy, TILE_SIZE, TILE_SIZE).fill(fill(1, ox, oy));
          const wet = (b: number): boolean => b === 1;
          const northSouth = !wet(grid(x, y - 1)) || !wet(grid(x, y + 1));
          const eastWest = !wet(grid(x - 1, y)) || !wet(grid(x + 1, y));
          drawPlanks(this.layer, ox, oy, northSouth && !eastWest);
          continue;
        }

        // The tile's full square, then the diagonal edge cuts.
        this.layer.rect(ox, oy, TILE_SIZE, TILE_SIZE).fill(fill(byte, ox, oy));

        if (byte > 7) continue; // Built interior walls/floors keep square edges.
        const masks = [0, 0, 0, 0, 0, 0, 0, 0];
        let shoreMask = 0;
        for (const [dx, dy, bit] of NEIGHBOURS) {
          const neighbour = grid(x + dx, y + dy);
          if (neighbour > 7 || PRIORITY[neighbour] <= PRIORITY[byte]) continue;
          masks[neighbour] |= bit;
          if (byte === 1) shoreMask |= bit;
        }
        if (shoreMask) {
          const shore = artTexture(`transitions/shore/${shoreMask}`);
          if (shore) this.layer.rect(ox, oy, TILE_SIZE, TILE_SIZE).fill(fill(3, ox, oy, shore));
        }
        // Draw in priority order so multi-biome junctions agree on every tile.
        for (const neighbour of [2, 7, 3, 5, 0, 4, 6]) {
          const mask = masks[neighbour];
          if (!mask) continue;
          const overlay = transitionTexture(neighbour, mask);
          if (overlay)
            this.layer.rect(ox, oy, TILE_SIZE, TILE_SIZE).fill(fill(neighbour, ox, oy, overlay));
        }
      }
    }
  }
}

const PLANK = [0xa8743f, 0x94653a, 0x9e6c3c, 0x8c5f35];

/**
 * Four boards across the direction of travel with a rail on each side.
 * `northSouth` is a walkway running up and down the screen.
 */
function drawPlanks(layer: Graphics, ox: number, oy: number, northSouth: boolean): void {
  const board = TILE_SIZE / 4;
  for (let i = 0; i < 4; i++) {
    if (northSouth) layer.rect(ox + 2, oy + i * board, TILE_SIZE - 4, board - 1).fill(PLANK[i]);
    else layer.rect(ox + i * board, oy + 2, board - 1, TILE_SIZE - 4).fill(PLANK[i]);
  }
  if (northSouth) {
    layer.rect(ox, oy, 3, TILE_SIZE).fill(0x5a3a1e);
    layer.rect(ox + TILE_SIZE - 3, oy, 3, TILE_SIZE).fill(0x5a3a1e);
  } else {
    layer.rect(ox, oy, TILE_SIZE, 3).fill(0x5a3a1e);
    layer.rect(ox, oy + TILE_SIZE - 3, TILE_SIZE, 3).fill(0x5a3a1e);
  }
}
