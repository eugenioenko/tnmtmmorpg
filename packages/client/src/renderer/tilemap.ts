import { Graphics } from 'pixi.js';

/** World tile edge in pixels; every sprite and rect is sized against it. */
export const TILE_SIZE = 32;

const TILE_COLORS: Record<string, number> = {
  grass: 0x3d7a3d,
  wall: 0x4a4a4a,
};

/**
 * Renders the tile layer from the local world model's known-tiles map. The
 * map is sparse — only non-grass tiles the server told us about; anything
 * else is grass — so a grass base fills the visible range first and the
 * known tiles overlay it.
 */
export class TilemapRenderer {
  // Last-drawn tilemap extent (the grass base follows the camera).
  private tilesKey = '';
  private minX = 0;
  private maxX = 0;
  private minY = 0;
  private maxY = 0;
  private readonly layer: Graphics;

  constructor(layer: Graphics) {
    this.layer = layer;
  }

  /**
   * Redraw the tilemap only when its contents or the camera position
   * changed. `tiles` is the world model's known-tiles map ('x,y' → kind);
   * the camera centre is the point the view is centred on (world px), and
   * the viewport is in CSS pixels.
   */
  rebuild(
    tiles: ReadonlyMap<string, string>,
    cameraCenterX: number,
    cameraCenterY: number,
    viewW: number,
    viewH: number,
  ): void {
    // The base must cover the camera view, padded by the snapshot's own
    // view radius so overlay tiles always land on base grass.
    const halfX = ~~(viewW / (2 * TILE_SIZE)) + 3;
    const halfY = ~~(viewH / (2 * TILE_SIZE)) + 3;
    let minX = ~~(cameraCenterX / TILE_SIZE) - halfX;
    let maxX = ~~(cameraCenterX / TILE_SIZE) + halfX;
    let minY = ~~(cameraCenterY / TILE_SIZE) - halfY;
    let maxY = ~~(cameraCenterY / TILE_SIZE) + halfY;
    const parsed: { x: number; y: number; kind: string }[] = [];
    for (const [key, kind] of tiles) {
      const comma = key.indexOf(',');
      parsed.push({
        x: Number(key.slice(0, comma)),
        y: Number(key.slice(comma + 1)),
        kind,
      });
      const tile = parsed[parsed.length - 1];
      if (tile.x < minX) minX = tile.x;
      if (tile.x > maxX) maxX = tile.x;
      if (tile.y < minY) minY = tile.y;
      if (tile.y > maxY) maxY = tile.y;
    }

    const key = parsed.map((t) => `${t.x},${t.y}:${t.kind}`).join('|');
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

    // Base grass: everything not listed in the snapshot is grass.
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        // A subtle checkerboard so open grass reads as a map, not a void.
        const shade = (x + y) & 1 ? -0x0a0a0a : 0;
        this.layer
          .rect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE)
          .fill(TILE_COLORS.grass + shade);
      }
    }

    // Non-grass tiles from the snapshot overlay the base.
    for (const tile of parsed) {
      const base = TILE_COLORS[tile.kind] ?? TILE_COLORS.grass;
      const shade = (tile.x + tile.y) & 1 ? -0x0a0a0a : 0;
      this.layer
        .rect(tile.x * TILE_SIZE, tile.y * TILE_SIZE, TILE_SIZE, TILE_SIZE)
        .fill(base + shade);
    }
  }
}
