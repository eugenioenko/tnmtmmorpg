import { Application, Container, Graphics } from 'pixi.js';
import type { DeltaSnapshot, EntityState, FullSnapshot, TileState } from '@game/shared';
import { Camera } from './camera.ts';
import { EntityRenderer } from './renderer/entities.ts';
import { TilemapRenderer } from './renderer/tilemap.ts';

export { TILE_SIZE } from './renderer/tilemap.ts';

/** How long a snapshot pair takes to complete its lerp; mirrors the server tick. */
const TICK_MS = 100;

/** Live numbers the UI overlay polls. */
export interface GameState {
  tick: number;
  entityCount: number;
  pingMs: number;
  fps: number;
  connected: boolean;
  /** Feature systems the server guard auto-disabled; shown in a banner. */
  disabledFeatures: string[];
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
}

interface BufferedSnapshot {
  snapshot: WorldState;
  /** performance.now() when the frame arrived; anchors the lerp clock. */
  receivedAt: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

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
  private readonly renderer: EntityRenderer;
  private readonly tilemap: TilemapRenderer;
  private readonly camera: Camera;
  private frameCount = 0;
  private fpsWindowMs = 0;
  private readonly app: Application;
  private readonly worldLayer: Container;

  private constructor(
    app: Application,
    worldLayer: Container,
    tileLayer: Graphics,
    entityLayer: Container,
  ) {
    this.app = app;
    this.worldLayer = worldLayer;
    this.tilemap = new TilemapRenderer(tileLayer);
    this.renderer = new EntityRenderer(entityLayer);
    this.camera = new Camera();
    this.state = {
      tick: 0,
      entityCount: 0,
      pingMs: 0,
      fps: 0,
      connected: false,
      disabledFeatures: [],
    };
  }

  /** Boot the Pixi app, wire the layers and start the 60fps render ticker. */
  static async create(): Promise<Game> {
    const canvas = document.getElementById('game-canvas');
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error('createGame: #game-canvas element not found');
    }

    const app = new Application();
    await app.init({
      canvas,
      background: 0x0d0d0d,
      resizeTo: window,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      powerPreference: 'high-performance',
    });
    app.ticker.maxFPS = 60;

    const worldLayer = new Container();
    const tileLayer = new Graphics();
    const entityLayer = new Container();
    worldLayer.addChild(tileLayer, entityLayer);
    app.stage.addChild(worldLayer);

    const game = new Game(app, worldLayer, tileLayer, entityLayer);
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

    // The tile base follows the camera centre from the previous frame's
    // entity positions (rebuild runs before positions update below).
    const viewW = this.app.renderer.width / this.app.renderer.resolution;
    const viewH = this.app.renderer.height / this.app.renderer.resolution;
    const centre = this.renderer.tileCenter(this.localEntityId);
    this.tilemap.rebuild(
      this.knownTiles,
      centre ? centre.x : 0,
      centre ? centre.y : 0,
      viewW,
      viewH,
    );

    // Render ~1 tick behind: when the newest snapshot arrives we are at the
    // previous one (alpha 0) and ease toward it over the next tick interval.
    const older = this.buffer.length >= 2 ? this.buffer[this.buffer.length - 2] : undefined;
    const alpha = older ? clamp((performance.now() - latest.receivedAt) / TICK_MS, 0, 1) : 1;

    // Desired render positions: entities in both snapshots lerp; entities in
    // only the older one freeze at their last position; entities in only the
    // newest one (fresh spawns) appear at their current position.
    const byId = new Map<number, EntityState>();
    if (older) {
      for (const entity of older.snapshot.entities) byId.set(entity.id, entity);
    }
    for (const entity of latest.snapshot.entities) byId.set(entity.id, entity);

    const positions = new Map<number, { x: number; y: number }>();
    if (older) {
      for (const entity of older.snapshot.entities) {
        positions.set(entity.id, { x: entity.x, y: entity.y });
      }
    }
    for (const entity of latest.snapshot.entities) {
      const from = positions.get(entity.id);
      positions.set(entity.id, {
        x: from ? from.x + (entity.x - from.x) * alpha : entity.x,
        y: from ? from.y + (entity.y - from.y) * alpha : entity.y,
      });
    }

    this.renderer.updatePositions(positions, byId, performance.now());

    // Crafting progress bars sit on top of the entities they describe.
    this.renderer.updateCraftBars(latest.snapshot);

    // Phase 7: health bars above damaged entities.
    this.renderer.updateHealthBars(latest.snapshot);

    // Keep the local player centred; the camera follows the just-updated
    // entity positions and the whole world layer gets the offset applied.
    this.camera.setViewport(viewW, viewH);
    this.camera.follow(this.renderer.tileCenter(this.localEntityId));
    this.camera.update();
    this.worldLayer.position.set(-this.camera.x, -this.camera.y);
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
    };
    this.buffer.push({ snapshot: worldState, receivedAt: performance.now() });
    if (this.buffer.length > 2) this.buffer.shift();
    this.state.tick = worldState.tick;
    this.state.entityCount = worldState.entities.length;

    // Ground-item stack counts change when someone picks up part of a
    // stack; refresh the count labels directly from the newest state.
    this.renderer.refreshCountLabels(worldState.entities);
  }

  /** Mark the entity id that belongs to this browser tab. */
  setLocalEntity(id: number | null): void {
    this.localEntityId = id;
    this.renderer.setLocalEntity(id); // repaints the white-outline highlight
  }

  /**
   * Phase 7: wire up click-to-attack. The handler receives the id of the
   * clicked entity (never the local player's own); the caller sends the
   * 'attack' intent. Pass null to disable.
   */
  setAttackHandler(handler: ((entityId: number) => void) | null): void {
    this.renderer.setAttackHandler(handler);
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
