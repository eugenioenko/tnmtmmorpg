import { Application, Container, Graphics, Sprite, Text } from 'pixi.js';
import type { CraftingComponent, EntityState, ItemDropComponent, Snapshot } from '@game/shared';
import { emojiForItem, emojiForKind, emojiTexture } from './emoji-atlas.ts';
import { getItemDef } from './items.ts';

export const TILE_SIZE = 32;

/** How long a snapshot pair takes to complete its lerp; mirrors the server tick. */
const TICK_MS = 100;

/** How long a despawned entity stays frozen on screen before vanishing. */
const FROZEN_MS = 3000;

const TILE_COLORS: Record<string, number> = {
  grass: 0x3d7a3d,
  wall: 0x4a4a4a,
};

/** Fallback palette when an entity has no player component with a color. */
const FALLBACK_COLORS = ['#c0392b', '#2980b9', '#27ae60', '#f39c12', '#8e44ad', '#16a085'];

const RECT_PAD = 3; // px inset so adjacent entities stay visually distinct
const EMOJI_SIZE = 22; // smaller than the rect so the color shows around the glyph
const ITEM_EMOJI_SIZE = 15; // ground items render smaller: they are things, not actors

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

export interface Game {
  /** Mutable live state; UI panels read it on a timer. */
  readonly state: GameState;
  /** Feed the latest authoritative snapshot from the server. */
  pushSnapshot(snapshot: Snapshot): void;
  /** Mark the entity id that belongs to this browser tab. */
  setLocalEntity(id: number | null): void;
  /** The local player's entity from the newest snapshot, or undefined. */
  localPlayer(): EntityState | undefined;
  /** The newest authoritative snapshot, or undefined before the first arrives. */
  latestSnapshot(): Snapshot | undefined;
  /** Tear down the Pixi app, ticker and all listeners. */
  destroy(): void;
}

interface BufferedSnapshot {
  snapshot: Snapshot;
  /** performance.now() when the frame arrived; anchors the lerp clock. */
  receivedAt: number;
}

interface RenderEntity {
  id: number;
  kind: string;
  /** Integer color for the backing rect, derived from components. */
  color: number;
  container: Container;
  /** null for ground items, which render without a backing rect. */
  rect: Graphics | null;
  emoji: Sprite;
  /** Stack-count label, only on ground item entities. */
  countLabel: Text | null;
  /** Phase 6: progress bars drawn above stations with active crafting jobs. */
  craftBar: Graphics;
  /** When the entity left the newest snapshot, or null while it is live. */
  frozenAt: number | null;
}

function isItemDrop(value: unknown): value is ItemDropComponent {
  if (typeof value !== 'object' || value === null) return false;
  const drop = value as Record<string, unknown>;
  return typeof drop.itemId === 'string' && typeof drop.count === 'number';
}

function isCrafting(value: unknown): value is CraftingComponent {
  if (typeof value !== 'object' || value === null) return false;
  const crafting = value as Record<string, unknown>;
  return Array.isArray(crafting.activeJobs) && Array.isArray(crafting.queue);
}

function entityColor(entity: EntityState): string {
  if (entity.kind === 'container') return '#8b5a2b'; // chests are brown, always
  const player = entity.components.player;
  if (typeof player === 'object' && player !== null) {
    const color = (player as Record<string, unknown>).color;
    if (typeof color === 'string') return color;
  }
  return FALLBACK_COLORS[entity.id % FALLBACK_COLORS.length];
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function colorToInt(hex: string): number {
  return parseInt(hex.slice(1), 16);
}

/**
 * The PixiJS game layer. Renders tiles and entities from the last two
 * snapshots, lerping positions between them at 60fps so the 10Hz
 * authoritative tick looks smooth. The camera follows the local player.
 * The server remains the sole source of truth — this is visual smoothing
 * only, with no prediction or rollback.
 *
 * Entity rendering (Phase 5):
 * - ground items (kind 'item') render as a small emoji with a count label;
 * - containers render with the chest glyph and a brown backing rect;
 * - everything else keeps the colored rect + glyph treatment.
 */
export async function createGame(): Promise<Game> {
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

  const state: GameState = {
    tick: 0,
    entityCount: 0,
    pingMs: 0,
    fps: 0,
    connected: false,
    disabledFeatures: [],
  };
  const buffer: BufferedSnapshot[] = [];
  const entities = new Map<number, RenderEntity>();
  let localEntityId: number | null = null;
  let worldW = 0; // world size in px, derived from the tilemap
  let worldH = 0;
  let tilesKey = '';
  let frameCount = 0;
  let fpsWindowMs = 0;

  /** Paint an entity's colored rect, with a white outline for the local player. */
  function paintRect(render: RenderEntity, isLocal: boolean): void {
    if (!render.rect) return; // ground items have no rect
    render.rect.clear();
    const size = TILE_SIZE - RECT_PAD * 2;
    render.rect.rect(RECT_PAD, RECT_PAD, size, size).fill(render.color);
    if (isLocal) {
      render.rect.stroke({ width: 2, color: 0xffffff });
    }
  }

  /**
   * One container per entity holding its rect and emoji together, so the
   * whole sprite keeps a single z-order: a player standing on an occupied
   * tile covers the entity underneath, like the old 2D canvas renderer.
   */
  function createRenderEntity(entity: EntityState): RenderEntity {
    const container = new Container();
    const isGroundItem = entity.kind === 'item' && isItemDrop(entity.components.itemDrop);

    let rect: Graphics | null = null;
    let countLabel: Text | null = null;
    let emoji: Sprite;

    if (isGroundItem) {
      const drop = entity.components.itemDrop as ItemDropComponent;
      emoji = new Sprite(emojiTexture(emojiForItem(drop.itemId, getItemDef(drop.itemId)?.tags)));
      emoji.anchor.set(0.5, 0.5);
      emoji.width = ITEM_EMOJI_SIZE;
      emoji.height = ITEM_EMOJI_SIZE;
      emoji.position.set(TILE_SIZE / 2, TILE_SIZE / 2);
      container.addChild(emoji);

      // Always create the label so later count changes (a partial pickup or
      // a merge from another drop) can update it; hidden while count <= 1.
      countLabel = new Text({
        text: drop.count > 1 ? String(drop.count) : '',
        style: {
          fontSize: 10,
          fill: 0xffffff,
          fontFamily: 'ui-monospace, monospace',
          fontWeight: 'bold',
        },
      });
      countLabel.anchor.set(0.5, 1);
      countLabel.position.set(TILE_SIZE / 2, TILE_SIZE - 1);
      container.addChild(countLabel);
    } else {
      rect = new Graphics();
      emoji = new Sprite(emojiTexture(emojiForKind(entity.kind)));
      emoji.anchor.set(0.5, 0.5);
      emoji.width = EMOJI_SIZE;
      emoji.height = EMOJI_SIZE;
      emoji.position.set(TILE_SIZE / 2, TILE_SIZE / 2);
      container.addChild(rect, emoji);
    }

    // Phase 6: one graphics layer for craft progress bars, drawn above the
    // rect and glyph; invisible until the entity has active crafting jobs.
    const craftBar = new Graphics();
    craftBar.visible = false;
    container.addChild(craftBar);

    const render: RenderEntity = {
      id: entity.id,
      kind: entity.kind,
      color: colorToInt(entityColor(entity)),
      container,
      rect,
      emoji,
      countLabel,
      craftBar,
      frozenAt: null,
    };
    paintRect(render, entity.id === localEntityId);
    container.position.set(entity.x * TILE_SIZE, entity.y * TILE_SIZE);
    entityLayer.addChild(container);
    return render;
  }

  /**
   * Phase 6: redraw the progress bar above every station with active crafting
   * jobs — one bar per job, stacked from the top of the tile, green when the
   * local player owns the job, blue otherwise. Read fresh from the newest
   * snapshot every frame, so progress ticks are visible in both clients.
   */
  function updateCraftBars(snapshot: Snapshot): void {
    for (const entity of snapshot.entities) {
      const render = entities.get(entity.id);
      if (!render) continue;
      const crafting = entity.components.crafting;
      if (!isCrafting(crafting) || crafting.activeJobs.length === 0) {
        render.craftBar.visible = false;
        continue;
      }
      render.craftBar.visible = true;
      render.craftBar.clear();
      crafting.activeJobs.forEach((job, index) => {
        const y = 2 + index * 5;
        const width = TILE_SIZE - 4;
        render.craftBar.rect(2, y, width, 3).fill(0x161616); // track
        // No Math.* (banned by lint): manual clamp + ~~(x + 0.5) rounding.
        const raw = job.progress / job.totalTicks;
        const frac = raw < 0 ? 0 : raw > 1 ? 1 : raw;
        const fillWidth = frac <= 0 ? 0 : ~~(width * frac + 0.5) < 2 ? 2 : ~~(width * frac + 0.5);
        render.craftBar
          .rect(2, y, fillWidth, 3)
          .fill(job.crafterEntityId === localEntityId ? 0x7ee787 : 0x61afef);
      });
    }
  }

  /** Redraw the tilemap only when its contents actually changed. */
  function rebuildTiles(snapshot: Snapshot): void {
    const key = snapshot.tiles.map((t) => `${t.x},${t.y}:${t.kind}`).join('|');
    if (key === tilesKey) return;
    tilesKey = key;
    tileLayer.clear();

    let maxX = 0;
    let maxY = 0;
    for (const tile of snapshot.tiles) {
      const base = TILE_COLORS[tile.kind] ?? 0x3d7a3d;
      // A subtle checkerboard so open grass reads as a map, not a void.
      const shade = (tile.x + tile.y) % 2 === 0 ? 0 : -0x0a0a0a;
      tileLayer
        .rect(tile.x * TILE_SIZE, tile.y * TILE_SIZE, TILE_SIZE, TILE_SIZE)
        .fill(base + shade);
      if (tile.x > maxX) maxX = tile.x;
      if (tile.y > maxY) maxY = tile.y;
    }
    worldW = (maxX + 1) * TILE_SIZE;
    worldH = (maxY + 1) * TILE_SIZE;
  }

  /** Keep the local player centred; clamp so the world edges stay visible. */
  function updateCamera(): void {
    const viewW = app.renderer.width / app.renderer.resolution;
    const viewH = app.renderer.height / app.renderer.resolution;

    const local = localEntityId !== null ? entities.get(localEntityId) : undefined;
    let cx: number;
    let cy: number;
    if (local) {
      cx = local.container.position.x + TILE_SIZE / 2 - viewW / 2;
      cy = local.container.position.y + TILE_SIZE / 2 - viewH / 2;
    } else {
      cx = worldW / 2 - viewW / 2;
      cy = worldH / 2 - viewH / 2;
    }
    if (viewW >= worldW) cx = (worldW - viewW) / 2;
    else cx = clamp(cx, 0, worldW - viewW);
    if (viewH >= worldH) cy = (worldH - viewH) / 2;
    else cy = clamp(cy, 0, worldH - viewH);
    worldLayer.position.set(-cx, -cy);
  }

  function update(): void {
    // FPS accounting (rolled every second).
    fpsWindowMs += app.ticker.deltaMS;
    frameCount++;
    if (fpsWindowMs >= 1000) {
      state.fps = ~~((frameCount * 1000) / fpsWindowMs);
      fpsWindowMs = 0;
      frameCount = 0;
    }

    const latest = buffer[buffer.length - 1];
    if (!latest) return;
    rebuildTiles(latest.snapshot);

    // Render ~1 tick behind: when the newest snapshot arrives we are at the
    // previous one (alpha 0) and ease toward it over the next tick interval.
    const older = buffer.length >= 2 ? buffer[buffer.length - 2] : undefined;
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

    // Existing render entities: move to their lerped spot, or start freezing
    // when they vanished from the newest snapshot.
    const now = performance.now();
    for (const render of entities.values()) {
      const target = positions.get(render.id);
      if (target) {
        render.container.position.set(target.x * TILE_SIZE, target.y * TILE_SIZE);
        render.frozenAt = null;
      } else if (render.frozenAt === null) {
        render.frozenAt = now; // despawned (or disconnected): freeze in place
      }
    }

    // Fresh entities from the newest snapshot.
    for (const [id, target] of positions) {
      if (!entities.has(id)) {
        const entity = byId.get(id);
        if (!entity) continue;
        const render = createRenderEntity(entity);
        render.container.position.set(target.x * TILE_SIZE, target.y * TILE_SIZE);
        entities.set(id, render);
      }
    }

    // Clean up long-frozen ghosts. Textures default to NOT being destroyed,
    // which is what we want: the atlas textures are shared by every entity.
    for (const [id, render] of entities) {
      if (render.frozenAt !== null && now - render.frozenAt > FROZEN_MS) {
        render.container.destroy({ children: true });
        entities.delete(id);
      }
    }

    // Crafting progress bars sit on top of the entities they describe.
    updateCraftBars(latest.snapshot);

    updateCamera();
  }

  app.ticker.add(update);

  return {
    get state(): GameState {
      return state;
    },

    pushSnapshot(snapshot: Snapshot): void {
      buffer.push({ snapshot, receivedAt: performance.now() });
      if (buffer.length > 2) buffer.shift();
      state.tick = snapshot.tick;
      state.entityCount = snapshot.entities.length;

      // Ground-item stack counts change when someone picks up part of a
      // stack; refresh the count labels directly from the newest snapshot.
      for (const entity of snapshot.entities) {
        if (entity.kind !== 'item') continue;
        const drop = entity.components.itemDrop;
        if (!isItemDrop(drop)) continue;
        const render = entities.get(entity.id);
        if (render?.countLabel) {
          const text = drop.count > 1 ? String(drop.count) : '';
          if (render.countLabel.text !== text) render.countLabel.text = text;
        }
      }
    },

    setLocalEntity(id: number | null): void {
      localEntityId = id;
      // Repaint the highlight: the old local player loses it, the new one gains it.
      for (const render of entities.values()) {
        paintRect(render, render.id === id);
      }
    },

    localPlayer(): EntityState | undefined {
      const latest = buffer[buffer.length - 1];
      if (!latest || localEntityId === null) return undefined;
      return latest.snapshot.entities.find((entity) => entity.id === localEntityId);
    },

    latestSnapshot(): Snapshot | undefined {
      return buffer[buffer.length - 1]?.snapshot;
    },

    destroy(): void {
      app.ticker.stop();
      app.destroy(false, { children: true });
    },
  };
}
