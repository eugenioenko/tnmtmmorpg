import { MAX_PAN_X, MAX_PAN_Y, TILE_SIZE } from '@game/shared';

/**
 * How hard the camera is pulled toward the player, per second. Higher is
 * snappier; lower drifts further behind before catching up. ~8 gives a
 * visible trail on a single step without feeling loose.
 */
const FOLLOW_RATE = 8;

/**
 * Past this distance the camera stops easing and jumps. A 100-tile WASD
 * stride would otherwise spend seconds sliding across the map with the
 * player off-screen the whole way.
 */
const SNAP_DISTANCE = 400;

/**
 * The camera. Follows the local player's tile centre at 1:1 pixels per tile.
 * The world is a torus with no edges to clamp against, so there is nothing
 * to stop the camera at.
 *
 * The follow is a rubber band, not a rigid lock: each frame the camera eases
 * a fraction of the remaining distance toward the player, so it trails a
 * step behind and settles once they stop. Pinning the player dead centre
 * made every single step slide the entire map underneath a stationary
 * sprite, which reads as the world moving rather than the player.
 *
 * IMPORTANT for anything that draws the world: the camera no longer sits on
 * the player, so the tilemap must be built around the CAMERA centre. Drawing
 * it around the player leaves the drawn rectangle offset from the visible
 * one, which shows up as black bands along the edges while moving.
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
  /** False until the first frame with a target, so the camera starts centred. */
  private anchored = false;
  /**
   * Free-look offset from the follow target, in world pixels. The camera is
   * NOT welded to the player: this is added on top, so the view can be moved
   * while the player stands still. Clamped to the surplus the server sends
   * beyond the visible area — panning further would show ground the client
   * was never given.
   */
  private panX = 0;
  private panY = 0;

  /** Update the viewport size (CSS pixels); the camera centres itself within it. */
  setViewport(width: number, height: number): void {
    this.viewW = width;
    this.viewH = height;
  }

  /** Follow a world-pixel point; pass null to fall back to the spawn area view. */
  follow(target: { x: number; y: number } | null): void {
    this.targetX = target?.x ?? null;
    this.targetY = target?.y ?? null;
    if (target === null) this.anchored = false;
  }

  /**
   * Nudge the free-look offset, in world pixels. Clamped to the margin the
   * server sends beyond the visible area.
   */
  pan(dx: number, dy: number): void {
    const nx = this.panX + dx;
    const ny = this.panY + dy;
    this.panX = nx < -MAX_PAN_X ? -MAX_PAN_X : nx > MAX_PAN_X ? MAX_PAN_X : nx;
    this.panY = ny < -MAX_PAN_Y ? -MAX_PAN_Y : ny > MAX_PAN_Y ? MAX_PAN_Y : ny;
  }

  /** Drop the free-look offset; the camera eases back onto the player. */
  recentre(): void {
    this.panX = 0;
    this.panY = 0;
  }

  /** True when the view is currently offset from the player. */
  get panned(): boolean {
    return this.panX !== 0 || this.panY !== 0;
  }

  /**
   * Ease the camera toward its target. `deltaSeconds` is the frame time, so
   * the trail is the same length at 30fps as at 144fps.
   */
  update(deltaSeconds: number): void {
    const viewW = this.viewW;
    const viewH = this.viewH;

    if (this.targetX === null || this.targetY === null) {
      // Before the local player renders: look at the spawn area near the origin.
      this.posX = TILE_SIZE * 10 - viewW / 2;
      this.posY = TILE_SIZE * 10 - viewH / 2;
      return;
    }

    // Where the camera wants to end up: the follow target, plus whatever
    // free-look offset the player has panned to.
    const wantX = this.targetX + this.panX - viewW / 2;
    const wantY = this.targetY + this.panY - viewH / 2;

    const dx = wantX - this.posX;
    const dy = wantY - this.posY;
    const adx = dx < 0 ? -dx : dx;
    const ady = dy < 0 ? -dy : dy;

    // First frame, or a jump too far to ease across (the WASD stride, a
    // respawn): land on the player rather than sliding for seconds.
    if (!this.anchored || adx > SNAP_DISTANCE || ady > SNAP_DISTANCE) {
      this.anchored = true;
      this.posX = wantX;
      this.posY = wantY;
      return;
    }

    // Exponential ease: cover a fixed fraction of the remaining gap per
    // second. Clamped so a long frame cannot overshoot past the target.
    let t = FOLLOW_RATE * deltaSeconds;
    if (t > 1) t = 1;
    else if (t < 0) t = 0;
    this.posX += dx * t;
    this.posY += dy * t;
  }

  /** The point the view is centred on, in world pixels. */
  get centreX(): number {
    return this.posX + this.viewW / 2;
  }

  get centreY(): number {
    return this.posY + this.viewH / 2;
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
