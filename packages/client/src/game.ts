import { Application, Container, Graphics, type FederatedPointerEvent } from 'pixi.js';
import type { DeltaSnapshot, EntityState, FullSnapshot, TileState } from '@game/shared';
import {
  MAX_VIEW_HEIGHT,
  MAX_VIEW_WIDTH,
  OVERWORLD,
  TILE_BYTE_BY_KIND,
  TILE_SIZE,
  WALKABLE_TILES,
} from '@game/shared';
import { Camera } from './camera.ts';
import { EntityRenderer, type EntityPointer } from './renderer/entities.ts';
import { TilemapRenderer } from './renderer/tilemap.ts';
import { loadArt } from './art.ts';

export { TILE_SIZE } from './renderer/tilemap.ts';

/** Live numbers the UI overlay polls. */
export interface GameState {
  tick: number;
  entityCount: number;
  pingMs: number;
  fps: number;
  connected: boolean;
  /** The local player's authoritative world tile, straight from the snapshot. */
  playerX: number;
  playerY: number;
  /** Which world the player is in; drives the tile palette. */
  world: string;
  /** Feature systems the server guard auto-disabled; shown in a banner. */
  disabledFeatures: string[];
  localEntityId: number | null;
}

/**
 * The client's accumulated view of the world. `full` messages replace it,
 * `delta` messages patch it; the renderer and the interpolation buffer only
 * ever read materialized copies of this.
 */
export interface WorldState {
  tick: number;
  entities: EntityState[];
  /** Sparse: only non-grass tiles the server told us about. Anything else is grass. */
  tiles: TileState[];
  playerX: number;
  playerY: number;
  world: string;
}

interface BufferedSnapshot {
  snapshot: WorldState;
  /** performance.now() when the frame arrived; anchors the lerp clock. */
  receivedAt: number;
}

/** Ground and entity pointer input, routed to the controls layer. */
export interface PointerSink {
  entity(id: number, type: EntityPointer, shift: boolean): void;
  ground(tileX: number, tileY: number, shift: boolean): void;
  hoverTile(tileX: number, tileY: number): void;
}

/** Hooks fired once per authoritative snapshot, after the model is patched. */
export type SnapshotListener = (state: WorldState) => void;

/**
 * The PixiJS game layer. Renders tiles and entities from the last two
 * snapshots, lerping positions between them at 60fps so the 10Hz
 * authoritative tick looks smooth. The camera follows the local player.
 * The server remains the sole source of truth — this is visual smoothing
 * only, with no prediction or rollback.
 *
 * The Game orchestrates three subsystems:
 * - TilemapRenderer draws the sparse known-tiles model over a grass base;
 * - EntityRenderer owns the entity sprites, health/craft bars and the
 *   click-to-attack hit areas;
 * - Camera keeps the local player centred, converting between world and
 *   screen coordinates.
 */
export class Game {
  /** Mutable live state; UI panels read it on a timer. */
  readonly state: GameState;
  /** Snapshot interpolation buffer: the newest two materialized world states. */
  private readonly buffer: BufferedSnapshot[] = [];
  // The accumulated world model: full snapshots replace it, deltas patch it,
  // and every message materializes a copy into the interpolation buffer.
  private readonly knownTiles = new Map<string, string>(); // "x,y" → kind
  private readonly modelEntities = new Map<number, EntityState>();
  private localEntityId: number | null = null;
  /** The world currently on screen; a change wipes the rendered sprites. */
  private renderedWorld = OVERWORLD;
  private readonly renderer: EntityRenderer;
  private readonly tilemap: TilemapRenderer;
  private readonly camera: Camera;
  private frameCount = 0;
  private fpsWindowMs = 0;
  private readonly app: Application;
  private readonly worldLayer: Container;
  private readonly snapshotListeners: SnapshotListener[] = [];
  private pointerSink: PointerSink | null = null;
  private frameHooks: ((now: number) => void)[] = [];
  private readonly markerLayer = new Graphics();
  private marker: { x: number; y: number } | null = null;
  private markerSince = 0;
  /**
   * Adopt the server's declared view window (set in create()). The server is
   * authoritative about how much world it sends; the canvas is capped so the
   * client never renders ground it was not given.
   */
  setViewLimits: (radiusX: number, radiusY: number, tileSize: number) => void = () => {};

  private constructor(
    app: Application,
    worldLayer: Container,
    tileLayer: Graphics,
    entityLayer: Container,
  ) {
    this.app = app;
    this.worldLayer = worldLayer;
    worldLayer.addChildAt(this.markerLayer, 1);
    this.tilemap = new TilemapRenderer(tileLayer);
    this.renderer = new EntityRenderer(entityLayer);
    this.camera = new Camera();
    this.state = {
      tick: 0,
      entityCount: 0,
      pingMs: 0,
      fps: 0,
      connected: false,
      playerX: 0,
      playerY: 0,
      world: OVERWORLD,
      disabledFeatures: [],
      localEntityId: null,
    };
    this.renderer.setPointerHandler((id, type, e) => {
      if (type === 'tap') e.stopPropagation();
      this.pointerSink?.entity(id, type, e.shiftKey);
    });
  }

  /** Boot the Pixi app, wire the layers and start the 60fps render ticker. */
  static async create(): Promise<Game> {
    const canvas = document.getElementById('game-canvas');
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error('createGame: #game-canvas element not found');
    }

    /**
     * The canvas is capped at the tiles the server actually sends, and
     * letterboxed inside the window rather than filling it.
     *
     * Filling the window meant the drawn range was derived from the browser
     * size while the server's window was a fixed 61x41 tiles. Past about
     * 1790px wide the client was drawing ground it had never been told
     * about; those tiles fell back to grass and then snapped to their real
     * terrain as the player walked into them — the flicker along whichever
     * edge was leading. A fixed window also keeps a shared world fair: a 4K
     * monitor would otherwise reveal several times more map than a laptop.
     */
    // Defaults until the server's welcome arrives; setViewLimits tightens
    // them to whatever this server actually sends.
    let maxW = MAX_VIEW_WIDTH;
    let maxH = MAX_VIEW_HEIGHT;
    function viewportSize(): { w: number; h: number } {
      return {
        w: window.innerWidth < maxW ? window.innerWidth : maxW,
        h: window.innerHeight < maxH ? window.innerHeight : maxH,
      };
    }

    const initial = viewportSize();
    const app = new Application();
    await app.init({
      canvas,
      preference: 'webgl',
      background: 0x141518,
      width: initial.w,
      height: initial.h,
      autoDensity: true,
      resolution: 1,
      antialias: false,
      failIfMajorPerformanceCaveat: false,
    });
    app.ticker.maxFPS = 60;
    await loadArt();

    // Re-clamp on resize; `resizeTo: window` would grow past the server's
    // window again. The CSS in index.html centres the canvas in the page.
    window.addEventListener('resize', () => {
      const { w, h } = viewportSize();
      app.renderer.resize(w, h);
    });

    const worldLayer = new Container();
    const tileLayer = new Graphics();
    const entityLayer = new Container();
    entityLayer.sortableChildren = true;
    worldLayer.addChild(tileLayer, entityLayer);
    app.stage.addChild(worldLayer);

    const game = new Game(app, worldLayer, tileLayer, entityLayer);
    app.stage.eventMode = 'static';
    app.stage.hitArea = app.screen;
    app.stage.on('pointertap', (e: FederatedPointerEvent) => {
      const tile = game.screenToTile(e.global.x, e.global.y);
      game.pointerSink?.ground(tile.x, tile.y, e.shiftKey);
    });
    app.stage.on('pointermove', (e: FederatedPointerEvent) => {
      const tile = game.screenToTile(e.global.x, e.global.y);
      game.pointerSink?.hoverTile(tile.x, tile.y);
    });
    /**
     * Adopt the server's declared view window. The server is authoritative
     * about how much world it sends; rendering past it would show ground the
     * client was never given (it would fall back to grass and then snap to
     * real terrain — the old edge flicker). Resizing below the cap is fine.
     */
    game.setViewLimits = (radiusX: number, radiusY: number, tileSize: number): void => {
      if (!(radiusX > 0) || !(radiusY > 0) || !(tileSize > 0)) return;
      // radiusX/Y are the DISPLAYABLE radii the server declares; the window
      // it actually sends is wider, to give the camera room to pan.
      maxW = (2 * radiusX + 1) * tileSize;
      maxH = (2 * radiusY + 1) * tileSize;
      const { w, h } = viewportSize();
      app.renderer.resize(w, h);
    };
    app.ticker.add(() => game.update());
    return game;
  }

  private update(): void {
    // FPS accounting (rolled every second).
    this.fpsWindowMs += this.app.ticker.deltaMS;
    this.frameCount++;
    if (this.fpsWindowMs >= 1000) {
      this.state.fps = ~~((this.frameCount * 1000) / this.fpsWindowMs);
      this.fpsWindowMs = 0;
      this.frameCount = 0;
    }

    const latest = this.buffer[this.buffer.length - 1];
    if (!latest) return;

    const viewW = this.app.renderer.width / this.app.renderer.resolution;
    const viewH = this.app.renderer.height / this.app.renderer.resolution;

    // Advance the camera BEFORE drawing, and draw the tilemap around the
    // CAMERA centre rather than the player.
    //
    // These were the same point while the player was pinned dead centre, so
    // drawing around the player worked by coincidence. The moment the camera
    // can sit anywhere else — trailing behind on a rubber band, or panned
    // away by free-look — the drawn rectangle stops covering the visible one
    // and the uncovered strip renders as black bands along the edges.
    this.camera.setViewport(viewW, viewH);
    this.camera.follow(this.renderer.tileCenter(this.localEntityId));
    this.camera.update(this.app.ticker.deltaMS / 1000);
    // Changing world invalidates everything on screen: drop the old world's
    // sprites at once rather than letting them linger through the despawn
    // freeze, and start the interpolation fresh so nothing slides across.
    if (latest.snapshot.world !== this.renderedWorld) {
      this.renderedWorld = latest.snapshot.world;
      this.renderer.clear();
    }
    this.tilemap.setWorld(latest.snapshot.world);
    this.tilemap.rebuild(this.knownTiles, this.camera.centreX, this.camera.centreY, viewW, viewH);

    const byId = new Map<number, EntityState>();
    const targets = new Map<number, { x: number; y: number }>();
    for (const entity of latest.snapshot.entities) {
      byId.set(entity.id, entity);
      targets.set(entity.id, { x: entity.x, y: entity.y });
    }
    const now = performance.now();
    for (const hook of this.frameHooks) hook(now);
    this.renderer.updatePositions(targets, byId, now, this.app.ticker.deltaMS);

    // Crafting progress bars sit on top of the entities they describe.
    this.renderer.updateCraftBars(latest.snapshot);

    // Phase 7: health bars above damaged entities.
    this.renderer.updateHealthBars(latest.snapshot);

    this.drawMarker(now);

    // The camera advanced at the top of the frame (the tilemap is drawn
    // around it); apply its offset to the whole world layer.
    this.worldLayer.position.set(-this.camera.x, -this.camera.y);
  }

  /**
   * The camera centre in world TILES. The client reports this so the server
   * can centre its snapshot on what is actually being looked at rather than
   * on the player, who the camera is deliberately not welded to.
   */
  viewTile(): { x: number; y: number } {
    // Manual rounding: `Math` is banned by lint (it would hide Math.random,
    // which breaks seeded reproducibility). Half-away-from-zero, so this
    // stays correct if a wrapped camera centre goes briefly negative.
    const round = (v: number): number => (v >= 0 ? (v + 0.5) | 0 : -((-v + 0.5) | 0));
    return {
      x: round(this.camera.centreX / TILE_SIZE - 0.5),
      y: round(this.camera.centreY / TILE_SIZE - 0.5),
    };
  }

  /** Free-look: nudge the view off the player, in world pixels. */
  panCamera(dx: number, dy: number): void {
    this.camera.pan(dx, dy);
  }

  /** Free-look: drop the offset so the view eases back onto the player. */
  recentreCamera(): void {
    this.camera.recentre();
  }

  /** Feed the latest authoritative snapshot (full or delta) from the server. */
  pushSnapshot(msg: FullSnapshot | DeltaSnapshot): void {
    if (msg.t === 'full') {
      // Full snapshot: the client's accumulated state is replaced wholesale.
      this.knownTiles.clear();
      for (const tile of msg.tiles) this.knownTiles.set(`${tile.x},${tile.y}`, tile.kind);
      this.modelEntities.clear();
      for (const entity of msg.entities) this.modelEntities.set(entity.id, entity);
    } else {
      // Delta: patch the accumulated state on top of what we already have.
      for (const id of msg.removedEntities) this.modelEntities.delete(id);
      for (const entity of msg.entities) this.modelEntities.set(entity.id, entity);
      for (const tile of msg.tiles) this.knownTiles.set(`${tile.x},${tile.y}`, tile.kind);
      for (const tile of msg.removedTiles) this.knownTiles.delete(`${tile.x},${tile.y}`);
    }

    // Materialize the accumulated model so the interpolation buffer always
    // holds complete world states, exactly as it did with full snapshots.
    const worldState: WorldState = {
      tick: msg.tick,
      entities: [...this.modelEntities.values()],
      tiles: [...this.knownTiles].map(([key, kind]) => {
        const comma = key.indexOf(',');
        return { x: Number(key.slice(0, comma)), y: Number(key.slice(comma + 1)), kind };
      }),
      playerX: msg.playerX,
      playerY: msg.playerY,
      world: msg.world ?? OVERWORLD,
    };
    this.buffer.push({ snapshot: worldState, receivedAt: performance.now() });
    if (this.buffer.length > 2) this.buffer.shift();
    this.state.tick = worldState.tick;
    this.state.entityCount = worldState.entities.length;
    this.state.playerX = worldState.playerX;
    this.state.playerY = worldState.playerY;
    this.state.world = worldState.world;

    // Ground-item stack counts change when someone picks up part of a
    // stack; refresh the count labels directly from the newest state.
    this.renderer.refreshCountLabels(worldState.entities);
    for (const listener of this.snapshotListeners) listener(worldState);
  }

  /** Click-to-move destination marker; null hides it. */
  setMarker(tile: { x: number; y: number } | null): void {
    this.marker = tile;
    this.markerSince = performance.now();
  }

  private drawMarker(now: number): void {
    const g = this.markerLayer;
    g.clear();
    if (!this.marker) return;
    const age = (now - this.markerSince) / 1000;
    const cx = this.marker.x * TILE_SIZE + TILE_SIZE / 2;
    const cy = this.marker.y * TILE_SIZE + TILE_SIZE / 2 + 6;
    const intro = age < 0.25 ? 1.6 - age * 2.4 : 1;
    const pulse = 1 + ((age * 2) % 1) * 0.15;
    const r = 9 * intro * pulse;
    g.ellipse(cx, cy, r, r * 0.5).stroke({ width: 2, color: 0xffe08a, alpha: 0.9 });
    g.ellipse(cx, cy, r * 0.45, r * 0.22).fill({ color: 0xffe08a, alpha: 0.55 });
  }

  onSnapshot(listener: SnapshotListener): void {
    this.snapshotListeners.push(listener);
  }

  onFrame(hook: (now: number) => void): void {
    this.frameHooks.push(hook);
  }

  setPointerSink(sink: PointerSink | null): void {
    this.pointerSink = sink;
  }

  /** Canvas pixel -> world tile, through the camera. */
  screenToTile(sx: number, sy: number): { x: number; y: number } {
    const wx = sx + this.camera.x;
    const wy = sy + this.camera.y;
    const fl = (v: number): number => (v >= 0 ? v | 0 : (v | 0) - (v % 1 === 0 ? 0 : 1));
    return { x: fl(wx / TILE_SIZE), y: fl(wy / TILE_SIZE) };
  }

  /** World tile -> canvas pixel (top-left of the tile). */
  tileToScreen(x: number, y: number): { x: number; y: number } {
    return { x: x * TILE_SIZE - this.camera.x, y: y * TILE_SIZE - this.camera.y };
  }

  /** Core's walkability rule over the tiles this client knows about. */
  walkable(x: number, y: number): boolean {
    const kind = this.knownTiles.get(`${x},${y}`);
    if (kind === undefined) return true;
    const byte = TILE_BYTE_BY_KIND[kind];
    return byte !== undefined && WALKABLE_TILES.has(byte);
  }

  tileKind(x: number, y: number): string {
    return this.knownTiles.get(`${x},${y}`) ?? 'grass';
  }

  entity(id: number): EntityState | undefined {
    return this.modelEntities.get(id);
  }

  entities(): IterableIterator<EntityState> {
    return this.modelEntities.values();
  }

  visualTile(id: number): { x: number; y: number } | null {
    return this.renderer.visualTile(id);
  }

  /** Overlay pixel of an entity's tile: horizontal centre, top edge. */
  screenOf(id: number): { x: number; y: number } | null {
    const tile = this.renderer.visualTile(id);
    if (!tile) return null;
    const p = this.tileToScreen(tile.x, tile.y);
    return { x: p.x + TILE_SIZE / 2, y: p.y };
  }

  setHovered(id: number | null): void {
    this.renderer.setHovered(id);
  }

  setTarget(id: number | null): void {
    this.renderer.setTarget(id);
  }

  floatText(x: number, y: number, text: string, color: number, size?: number): void {
    this.renderer.floatText(x, y, text, color, size);
  }

  /** Canvas element, for cursor styling. */
  canvas(): HTMLCanvasElement {
    return this.app.canvas;
  }

  /** Mark the entity id that belongs to this browser tab. */
  setLocalEntity(id: number | null): void {
    this.localEntityId = id;
    this.state.localEntityId = id;
    this.renderer.setLocalEntity(id); // repaints the white-outline highlight
  }

  /** The local player's entity from the newest state, or undefined. */
  localPlayer(): EntityState | undefined {
    const latest = this.buffer[this.buffer.length - 1];
    if (!latest || this.localEntityId === null) return undefined;
    return latest.snapshot.entities.find((entity) => entity.id === this.localEntityId);
  }

  /**
   * The accumulated world state from the newest snapshot (fulls replace it,
   * deltas patch it), or undefined before the first arrives.
   */
  latestSnapshot(): WorldState | undefined {
    return this.buffer[this.buffer.length - 1]?.snapshot;
  }

  /** Tear down the Pixi app, ticker and all listeners. */
  destroy(): void {
    this.app.ticker.stop();
    this.app.destroy(false, { children: true });
  }
}

/** Boot the game layer: init the Pixi app and return the running Game. */
export async function createGame(): Promise<Game> {
  return Game.create();
}
