import { Container, Graphics, Rectangle, Sprite, Text } from 'pixi.js';
import type { CraftingComponent, EntityState, ItemDropComponent } from '@game/shared';
import { isStatsComponent } from '@game/shared';
import { emojiForItem, emojiForKind, emojiTexture } from '../emoji-atlas.ts';
import { getItemDef } from '../items.ts';
import { TILE_SIZE } from './tilemap.ts';
import { entityAppearance, paintEntityArt, type ArtState } from '../art.ts';

/** Fallback palette when an entity has no player component with a color. */
const FALLBACK_COLORS = ['#c0392b', '#2980b9', '#27ae60', '#f39c12', '#8e44ad', '#16a085'];

const RECT_PAD = 3; // px inset so adjacent entities stay visually distinct
const EMOJI_SIZE = 22; // smaller than the rect so the color shows around the glyph
const ITEM_EMOJI_SIZE = 15; // ground items render smaller: they are things, not actors

/** How long a despawned entity stays frozen on screen before vanishing. */
const FROZEN_MS = 3000;

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
  /** Phase 7: health bar above damaged entities; invisible at full hp. */
  hpBar: Graphics;
  /** When the entity left the newest snapshot, or null while it is live. */
  frozenAt: number | null;
  art: ArtState;
  textured: boolean;
  lastUpdate: number;
  lastMoved: number;
  marker: number | undefined;
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

function colorToInt(hex: string): number {
  return parseInt(hex.slice(1), 16);
}

/**
 * Renders entities from the newest snapshot: one container per entity
 * holding its colored rect and emoji glyph, health and craft bars, and the
 * click-to-attack hit area. The server remains the sole source of truth —
 * this is visual smoothing only, with no prediction or rollback.
 *
 * Entity rendering (Phase 5):
 * - ground items (kind 'item') render as a small emoji with a count label;
 * - containers render with the chest glyph and a brown backing rect;
 * - everything else keeps the colored rect + glyph treatment.
 */
export class EntityRenderer {
  private readonly entities = new Map<number, RenderEntity>();
  /** Phase 7: click-to-attack callback (set via setAttackHandler); null = disabled. */
  private attackHandler: ((entityId: number) => void) | null = null;
  /** The entity id that belongs to this browser tab; drives the white outline. */
  private localEntityId: number | null = null;
  private readonly layer: Container;

  constructor(layer: Container) {
    this.layer = layer;
  }

  /** Paint an entity's colored rect, with a white outline for the local player. */
  private paintRect(render: RenderEntity, isLocal: boolean): void {
    if (!render.rect) return; // ground items have no rect
    render.rect.clear();
    if (render.textured) {
      if (render.marker !== undefined) {
        render.rect
          .ellipse(16, 24, 19, 10)
          .fill(0x202c34)
          .stroke({ width: 3, color: render.marker });
        render.rect.ellipse(16, 24, 13, 6).stroke({ width: 1, color: render.marker });
      }
      // A small ring keeps the local player identifiable without covering art.
      if (isLocal) render.rect.ellipse(16, 27, 12, 5).stroke({ width: 1.5, color: 0xffefb0 });
      return;
    }
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
  private createRenderEntity(entity: EntityState): RenderEntity {
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

    // Phase 7: one graphics layer for the health bar, drawn just above the
    // tile; invisible until the entity has stats with missing hp.
    const hpBar = new Graphics();
    hpBar.visible = false;
    container.addChild(hpBar);

    // Phase 7: click an entity to attack it. Only the local player's own
    // entity is excluded; the server validates stats and adjacency, so a
    // click on a non-combat entity is a harmless no-op.
    container.eventMode = 'static';
    container.hitArea = new Rectangle(0, -16, TILE_SIZE, TILE_SIZE + 16);
    container.cursor = 'pointer';
    container.on('pointertap', () => {
      if (this.attackHandler && entity.id !== this.localEntityId) {
        this.attackHandler(entity.id);
      }
    });

    const render: RenderEntity = {
      id: entity.id,
      kind: entity.kind,
      color: colorToInt(entityColor(entity)),
      container,
      rect,
      emoji,
      countLabel,
      craftBar,
      hpBar,
      frozenAt: null,
      art: { facing: 'south', walkTime: 0, moving: false },
      textured: false,
      lastUpdate: performance.now(),
      lastMoved: -1000,
      marker: entityAppearance(entity)?.marker,
    };
    render.textured = paintEntityArt(emoji, entity, render.art, performance.now());
    const label = entity.components.label;
    if (typeof label === 'string' && label.length > 0) {
      const name = new Text({
        text: label,
        style: {
          fontFamily: 'system-ui, sans-serif',
          fontSize: 11,
          fontWeight: 'bold',
          fill: 0xfff4d6,
          stroke: { color: 0x19241f, width: 3 },
        },
      });
      name.anchor.set(0.5, 1);
      name.position.set(16, render.marker === undefined ? emoji.y - 4 : -5);
      container.addChild(name);
    }
    this.paintRect(render, entity.id === this.localEntityId);
    container.position.set(entity.x * TILE_SIZE, entity.y * TILE_SIZE);
    this.layer.addChild(container);
    return render;
  }

  /**
   * Drop every sprite immediately, without the usual freeze-then-fade.
   *
   * Entities that vanish from a snapshot normally linger for FROZEN_MS so a
   * brief gap does not make things blink. Changing world is not a gap: the
   * previous world's contents are gone, and leaving them on screen draws the
   * old map's crowd standing in the new one.
   */
  clear(): void {
    for (const render of this.entities.values()) render.container.destroy({ children: true });
    this.entities.clear();
  }

  /**
   * Mark the entity id that belongs to this browser tab, repainting the
   * highlight: the old local player loses it, the new one gains it.
   */
  setLocalEntity(id: number | null): void {
    this.localEntityId = id;
    for (const render of this.entities.values()) {
      this.paintRect(render, render.id === id);
    }
  }

  /** Phase 7: wire up click-to-attack. Pass null to disable. */
  setAttackHandler(handler: ((entityId: number) => void) | null): void {
    this.attackHandler = handler;
  }

  /** The tile centre (world px) of a rendered entity, or null if it is not rendered. */
  tileCenter(id: number | null): { x: number; y: number } | null {
    if (id === null) return null;
    const render = this.entities.get(id);
    if (!render) return null;
    return {
      x: render.container.position.x + TILE_SIZE / 2,
      y: render.container.position.y + TILE_SIZE / 2,
    };
  }

  /**
   * Move existing render entities to their lerped spot, spawn fresh ones
   * from the newest snapshot, and clean up long-frozen ghosts. `positions`
   * holds the desired world tile for every entity in either snapshot;
   * `byId` resolves fresh spawns. Textures default to NOT being destroyed,
   * which is what we want: the atlas textures are shared by every entity.
   */
  updatePositions(
    positions: Map<number, { x: number; y: number }>,
    byId: Map<number, EntityState>,
    now: number,
  ): void {
    // Existing render entities: move to their lerped spot, or start freezing
    // when they vanished from the newest snapshot.
    for (const render of this.entities.values()) {
      const target = positions.get(render.id);
      if (target) {
        const dx = target.x * TILE_SIZE - render.container.x;
        const dy = target.y * TILE_SIZE - render.container.y;
        const moving = dx > 0.01 || dx < -0.01 || dy > 0.01 || dy < -0.01;
        const elapsed = now - render.lastUpdate;
        if (moving) render.lastMoved = now;
        render.art.moving = moving || now - render.lastMoved < 100;
        if (moving) {
          if (dx > 0.01 || dx < -0.01) render.art.facing = dx > 0 ? 'east' : 'west';
          else render.art.facing = dy > 0 ? 'south' : 'north';
        }
        if (render.art.moving) render.art.walkTime += elapsed < 100 ? elapsed : 100;
        else render.art.walkTime = 0;
        const entity = byId.get(render.id);
        if (entity) paintEntityArt(render.emoji, entity, render.art, now);
        render.lastUpdate = now;
        render.container.position.set(target.x * TILE_SIZE, target.y * TILE_SIZE);
        render.container.zIndex = target.y * TILE_SIZE + (render.kind === 'item' ? -1 : 0);
        render.frozenAt = null;
      } else if (render.frozenAt === null) {
        render.frozenAt = now; // despawned (or disconnected): freeze in place
      }
    }

    // Fresh entities from the newest snapshot.
    for (const [id, target] of positions) {
      if (!this.entities.has(id)) {
        const entity = byId.get(id);
        if (!entity) continue;
        const render = this.createRenderEntity(entity);
        render.container.position.set(target.x * TILE_SIZE, target.y * TILE_SIZE);
        render.container.zIndex = target.y * TILE_SIZE;
        this.entities.set(id, render);
      }
    }

    // Clean up long-frozen ghosts.
    for (const [id, render] of this.entities) {
      if (render.frozenAt !== null && now - render.frozenAt > FROZEN_MS) {
        render.container.destroy({ children: true });
        this.entities.delete(id);
      }
    }
  }

  /**
   * Phase 6: redraw the progress bar above every station with active crafting
   * jobs — one bar per job, stacked from the top of the tile, green when the
   * local player owns the job, blue otherwise. Read fresh from the newest
   * snapshot every frame, so progress ticks are visible in both clients.
   */
  updateCraftBars(snapshot: { entities: EntityState[] }): void {
    for (const entity of snapshot.entities) {
      const render = this.entities.get(entity.id);
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
          .fill(job.crafterEntityId === this.localEntityId ? 0x7ee787 : 0x61afef);
      });
    }
  }

  /**
   * Phase 7: redraw the health bar just above every damaged entity — green
   * above 50%, yellow above 25%, red at or below; hidden while at full hp
   * or without a stats component. Read fresh from the newest snapshot every
   * frame, like the craft bars.
   */
  updateHealthBars(snapshot: { entities: EntityState[] }): void {
    for (const entity of snapshot.entities) {
      const render = this.entities.get(entity.id);
      if (!render) continue;
      const stats = entity.components.stats;
      if (!isStatsComponent(stats) || stats.hp >= stats.maxHp) {
        render.hpBar.visible = false;
        continue;
      }
      render.hpBar.visible = true;
      render.hpBar.clear();
      const width = TILE_SIZE - 4;
      const y = -4; // just above the tile, so the bar reads as 'over' the entity
      render.hpBar.rect(2, y, width, 3).fill(0x161616); // track
      // No Math.* (banned by lint): manual clamp + ~~(x + 0.5) rounding.
      const raw = stats.hp / stats.maxHp;
      const frac = raw < 0 ? 0 : raw > 1 ? 1 : raw;
      const fillWidth = frac <= 0 ? 0 : ~~(width * frac + 0.5) < 2 ? 2 : ~~(width * frac + 0.5);
      const color = frac > 0.5 ? 0x7ee787 : frac > 0.25 ? 0xe5c07b : 0xe06c75;
      render.hpBar.rect(2, y, fillWidth, 3).fill(color);
    }
  }

  /**
   * Ground-item stack counts change when someone picks up part of a stack
   * or a drop merges into another; refresh the count labels directly from
   * the newest state.
   */
  refreshCountLabels(entities: EntityState[]): void {
    for (const entity of entities) {
      if (entity.kind !== 'item') continue;
      const drop = entity.components.itemDrop;
      if (!isItemDrop(drop)) continue;
      const render = this.entities.get(entity.id);
      if (render?.countLabel) {
        const text = drop.count > 1 ? String(drop.count) : '';
        if (render.countLabel.text !== text) render.countLabel.text = text;
      }
    }
  }
}
