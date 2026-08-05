import { TILE_SIZE } from './renderer/tilemap.ts';

/**
 * The camera. Follows a target point (the local player's tile centre) at
 * 1:1 pixels per tile. The world is large and sparse, with no edges to
 * clamp against — the camera simply follows the player (border wall tiles
 * render when the player approaches the world edge). Before the local
 * player renders, it looks at the spawn area near the origin.
 */
export class Camera {
  /** Camera position in world pixels (top-left corner of the view). */
  private posX = 0;
  private posY = 0;
  /** Follow target in world pixels, or null for the spawn-area view. */
  private targetX: number | null = null;
  private targetY: number | null = null;
  private viewW = 0;
  private viewH = 0;

  /** Update the viewport size (CSS pixels); the camera centres itself within it. */
  setViewport(width: number, height: number): void {
    this.viewW = width;
    this.viewH = height;
  }

  /** Follow a world-pixel point; pass null to fall back to the spawn area view. */
  follow(target: { x: number; y: number } | null): void {
    this.targetX = target?.x ?? null;
    this.targetY = target?.y ?? null;
  }

  /** Recompute the camera position from its target; call every frame. */
  update(): void {
    const viewW = this.viewW;
    const viewH = this.viewH;
    let cx: number;
    let cy: number;
    if (this.targetX !== null && this.targetY !== null) {
      // Keep the local player centred.
      cx = this.targetX - viewW / 2;
      cy = this.targetY - viewH / 2;
    } else {
      // Before the local player renders: look at the spawn area near the origin.
      cx = TILE_SIZE * 10 - viewW / 2;
      cy = TILE_SIZE * 10 - viewH / 2;
    }
    this.posX = cx;
    this.posY = cy;
  }

  /** Camera position in world pixels (top-left corner of the view). */
  get x(): number {
    return this.posX;
  }

  get y(): number {
    return this.posY;
  }

  /** Convert world pixels to screen pixels (CSS, relative to the canvas). */
  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: wx - this.posX, y: wy - this.posY };
  }

  /** Convert screen pixels (CSS, relative to the canvas) to world pixels. */
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: sx + this.posX, y: sy + this.posY };
  }
}
