import { Container, Graphics, Rectangle, Sprite, Text, type FederatedPointerEvent } from 'pixi.js';
import type { CraftingComponent, EntityState, ItemDropComponent } from '@game/shared';
import { isStatsComponent } from '@game/shared';
import { emojiForItem, emojiForKind, emojiTexture } from '../emoji-atlas.ts';
import { getItemDef } from '../items.ts';
import { TILE_SIZE } from './tilemap.ts';
import { entityAppearance, isTreeArt, paintEntityArt, type ArtState } from '../art.ts';

/** Fallback palette when an entity has no player component with a color. */
const FALLBACK_COLORS = ['#c0392b', '#2980b9', '#27ae60', '#f39c12', '#8e44ad', '#16a085'];

const RECT_PAD = 3; // px inset so adjacent entities stay visually distinct
const EMOJI_SIZE = 22; // smaller than the rect so the color shows around the glyph
const ITEM_EMOJI_SIZE = 15; // ground items render smaller: they are things, not actors

/** How long a despawned entity stays frozen on screen before vanishing. */
const FROZEN_MS = 3000;

/** A first step after standing still takes this long to cross one tile. */
const DEFAULT_STEP_MS = 200;
const MIN_STEP_MS = 90;
const MAX_STEP_MS = 520;
/** Jumps further than this (strides, doors, respawns) snap instead of sliding. */
const SNAP_TILES = 2.5;

const FLOAT_MS = 1100;

export type EntityPointer = 'tap' | 'over' | 'out';

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
  /** The floating `label` component text, kept in step when it changes. */
  nameLabel: Text | null;
  /** Phase 6: progress bars drawn above stations with active crafting jobs. */
  craftBar: Graphics;
  /** Phase 7: health bar above damaged entities; invisible at full hp. */
  hpBar: Graphics;
  /** Hover / target ring under the feet. */
  ring: Graphics;
  /** When the entity left the newest snapshot, or null while it is live. */
  frozenAt: number | null;
  art: ArtState;
  textured: boolean;
  lastUpdate: number;
  marker: number | undefined;
  /** Authoritative tile the sprite is heading for. */
  tileX: number;
  tileY: number;
  /** Tween from the visual position at the moment the tile changed. */
  fromX: number;
  fromY: number;
  tweenStart: number;
  tweenMs: number;
  lastTileChange: number;
  /** Visual position in tiles. */
  visX: number;
  visY: number;
  lastHp: number | null;
  lastLevel: number | null;
  actor: boolean;
  /** Drawn as a tree: a broad shadow, and see-through while you stand behind it. */
  tree: boolean;
}

interface FloatingText {
  text: Text;
  born: number;
  vx: number;
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

/** The player stands behind the tree's canopy, a little above its trunk. */
function hides(tree: RenderEntity, player: RenderEntity): boolean {
  const dx = player.visX - tree.visX;
  const dy = tree.visY - player.visY;
  return dy > 0.3 && dy < 3.2 && dx > -1.3 && dx < 1.3;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const absN = (v: number): number => (v < 0 ? -v : v);

/**
 * Renders entities from the newest snapshot: one container per entity
 * holding its sprite, rings, health and craft bars and pointer hit area. The
 * server remains the sole source of truth — positions here are visual only:
 * each time an entity's authoritative tile changes, its sprite slides there
 * over roughly the interval between its recent steps, so a walker stepping
 * once per server tick pair reads as continuous motion.
 */
export class EntityRenderer {
  private readonly entities = new Map<number, RenderEntity>();
  private pointerHandler: ((id: number, type: EntityPointer, e: FederatedPointerEvent) => void) | null =
    null;
  /** The entity id that belongs to this browser tab; drives the local ring. */
  private localEntityId: number | null = null;
  private hoveredId: number | null = null;
  private targetId: number | null = null;
  private readonly layer: Container;
  private readonly floats: FloatingText[] = [];

  constructor(layer: Container) {
    this.layer = layer;
  }

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
      } else if (render.actor) {
        render.rect.ellipse(16, 28, 10, 4).fill({ color: 0x000000, alpha: 0.22 });
      } else if (render.tree) {
        render.rect.ellipse(16, 28, 26, 8).fill({ color: 0x0b1a0c, alpha: 0.28 });
      }
      if (isLocal) render.rect.ellipse(16, 28, 12, 5).stroke({ width: 1.5, color: 0xffefb0 });
      return;
    }
    const size = TILE_SIZE - RECT_PAD * 2;
    render.rect.rect(RECT_PAD, RECT_PAD, size, size).fill(render.color);
    if (isLocal) {
      render.rect.stroke({ width: 2, color: 0xffffff });
    }
  }

  private paintRing(render: RenderEntity): void {
    const ring = render.ring;
    ring.clear();
    const targeted = render.id === this.targetId;
    const hovered = render.id === this.hoveredId;
    if (!targeted && !hovered) {
      ring.visible = false;
      return;
    }
    ring.visible = true;
    const color = targeted ? 0xff6b5a : 0xfff1c1;
    ring.ellipse(16, 28, 15, 6).stroke({ width: 2, color, alpha: targeted ? 0.95 : 0.7 });
  }

  /** Hit area spans the painted sprite as well as the tile, so tall art is clickable. */
  private fitHitArea(render: RenderEntity): void {
    const sprite = render.emoji;
    const w = sprite.texture.width * absN(sprite.scale.x);
    const h = sprite.texture.height * absN(sprite.scale.y);
    const left = sprite.scale.x < 0 ? sprite.x - w : sprite.x - sprite.anchor.x * w;
    const top = sprite.y - sprite.anchor.y * h;
    const x0 = left < 0 ? left : 0;
    const y0 = top < -8 ? top : -8;
    const x1 = left + w > TILE_SIZE ? left + w : TILE_SIZE;
    const y1 = top + h > TILE_SIZE ? top + h : TILE_SIZE;
    render.container.hitArea = new Rectangle(x0, y0, x1 - x0, y1 - y0);
  }

  private createRenderEntity(entity: EntityState): RenderEntity {
    const container = new Container();
    const isGroundItem = entity.kind === 'item' && isItemDrop(entity.components.itemDrop);
    const ring = new Graphics();
    ring.visible = false;
    container.addChild(ring);

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

      countLabel = new Text({
        text: drop.count > 1 ? String(drop.count) : '',
        style: {
          fontSize: 10,
          fill: 0xffffff,
          fontFamily: 'ui-monospace, monospace',
          fontWeight: 'bold',
          stroke: { color: 0x000000, width: 2 },
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

    const craftBar = new Graphics();
    craftBar.visible = false;
    container.addChild(craftBar);

    const hpBar = new Graphics();
    hpBar.visible = false;
    container.addChild(hpBar);

    container.eventMode = 'static';
    container.cursor = 'pointer';
    container.on('pointertap', (e: FederatedPointerEvent) => this.pointerHandler?.(entity.id, 'tap', e));
    container.on('pointerover', (e: FederatedPointerEvent) => this.pointerHandler?.(entity.id, 'over', e));
    container.on('pointerout', (e: FederatedPointerEvent) => this.pointerHandler?.(entity.id, 'out', e));

    const now = performance.now();
    const stats = entity.components.stats;
    const render: RenderEntity = {
      id: entity.id,
      kind: entity.kind,
      color: colorToInt(entityColor(entity)),
      container,
      rect,
      emoji,
      countLabel,
      nameLabel: null,
      craftBar,
      hpBar,
      ring,
      frozenAt: null,
      art: { facing: 'south', walkTime: 0, moving: false },
      textured: false,
      lastUpdate: now,
      marker: entityAppearance(entity)?.marker,
      tileX: entity.x,
      tileY: entity.y,
      fromX: entity.x,
      fromY: entity.y,
      tweenStart: 0,
      tweenMs: 0,
      lastTileChange: -10000,
      visX: entity.x,
      visY: entity.y,
      lastHp: isStatsComponent(stats) ? stats.hp : null,
      lastLevel: isStatsComponent(stats) ? stats.level : null,
      actor:
        entity.kind === 'player' ||
        entity.kind === 'npc' ||
        Boolean(entityAppearance(entity)?.creature ?? entityAppearance(entity)?.character),
      tree: isTreeArt(entity),
    };
    render.textured = paintEntityArt(emoji, entity, render.art, now);
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
      render.nameLabel = name;
    }
    this.paintRect(render, entity.id === this.localEntityId);
    this.fitHitArea(render);
    container.position.set(entity.x * TILE_SIZE, entity.y * TILE_SIZE);
    this.layer.addChild(container);
    return render;
  }

  /** Drop every sprite immediately (world change), without the freeze-then-fade. */
  clear(): void {
    for (const render of this.entities.values()) render.container.destroy({ children: true });
    this.entities.clear();
    for (const f of this.floats) f.text.destroy();
    this.floats.length = 0;
  }

  setLocalEntity(id: number | null): void {
    this.localEntityId = id;
    for (const render of this.entities.values()) {
      this.paintRect(render, render.id === id);
    }
  }

  setPointerHandler(
    handler: ((id: number, type: EntityPointer, e: FederatedPointerEvent) => void) | null,
  ): void {
    this.pointerHandler = handler;
  }

  setHovered(id: number | null): void {
    const prev = this.hoveredId;
    this.hoveredId = id;
    for (const rid of [prev, id]) {
      const r = rid === null ? undefined : this.entities.get(rid);
      if (r) this.paintRing(r);
    }
  }

  setTarget(id: number | null): void {
    const prev = this.targetId;
    this.targetId = id;
    for (const rid of [prev, id]) {
      const r = rid === null ? undefined : this.entities.get(rid);
      if (r) this.paintRing(r);
    }
  }

  /** The visual tile centre (world px) of a rendered entity, or null if it is not rendered. */
  tileCenter(id: number | null): { x: number; y: number } | null {
    if (id === null) return null;
    const render = this.entities.get(id);
    if (!render) return null;
    return {
      x: render.container.position.x + TILE_SIZE / 2,
      y: render.container.position.y + TILE_SIZE / 2,
    };
  }

  /** Visual tile position, for the minimap and overlays. */
  visualTile(id: number): { x: number; y: number } | null {
    const render = this.entities.get(id);
    return render ? { x: render.visX, y: render.visY } : null;
  }

  /** Spawn a rising, fading label above a tile (world tile coords). */
  floatText(x: number, y: number, text: string, color: number, size = 14): void {
    const label = new Text({
      text,
      style: {
        fontFamily: 'Georgia, "Times New Roman", serif',
        fontSize: size,
        fontWeight: 'bold',
        fill: color,
        stroke: { color: 0x120d08, width: 4 },
      },
    });
    label.anchor.set(0.5, 1);
    label.position.set(x * TILE_SIZE + TILE_SIZE / 2, y * TILE_SIZE - 10);
    label.zIndex = 1e9;
    this.layer.addChild(label);
    const jitter = ((this.floats.length * 37) % 11) - 5;
    this.floats.push({ text: label, born: performance.now(), vx: jitter * 2 });
  }

  private animateFloats(now: number, dtMs: number): void {
    for (let i = this.floats.length - 1; i >= 0; i--) {
      const f = this.floats[i];
      const age = now - f.born;
      if (age > FLOAT_MS) {
        f.text.destroy();
        this.floats.splice(i, 1);
        continue;
      }
      const t = age / FLOAT_MS;
      f.text.y -= (dtMs / 1000) * 34;
      f.text.x += (dtMs / 1000) * f.vx;
      f.text.alpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
      const pop = t < 0.12 ? 0.7 + (t / 0.12) * 0.5 : t < 0.22 ? 1.2 - ((t - 0.12) / 0.1) * 0.2 : 1;
      f.text.scale.set(pop);
    }
  }

  /**
   * Advance every sprite toward its authoritative tile, spawn fresh ones from
   * the newest snapshot, and clean up long-frozen ghosts. `targets` holds the
   * authoritative tile of every live entity.
   */
  updatePositions(
    targets: Map<number, { x: number; y: number }>,
    byId: Map<number, EntityState>,
    now: number,
    dtMs: number,
  ): void {
    const local = this.localEntityId === null ? undefined : this.entities.get(this.localEntityId);
    for (const render of this.entities.values()) {
      const target = targets.get(render.id);
      if (!target) {
        if (render.frozenAt === null) render.frozenAt = now;
        render.art.moving = false;
        continue;
      }
      render.frozenAt = null;

      if (target.x !== render.tileX || target.y !== render.tileY) {
        const dx = target.x - render.tileX;
        const dy = target.y - render.tileY;
        const far = absN(target.x - render.visX) + absN(target.y - render.visY) > SNAP_TILES;
        if (far) {
          render.visX = render.fromX = target.x;
          render.visY = render.fromY = target.y;
          render.tweenMs = 0;
        } else {
          const since = now - render.lastTileChange;
          render.fromX = render.visX;
          render.fromY = render.visY;
          render.tweenStart = now;
          render.tweenMs = since > MAX_STEP_MS + 150 ? DEFAULT_STEP_MS : clamp(since, MIN_STEP_MS, MAX_STEP_MS);
          if (absN(dx) >= absN(dy)) render.art.facing = dx > 0 ? 'east' : 'west';
          else render.art.facing = dy > 0 ? 'south' : 'north';
        }
        render.tileX = target.x;
        render.tileY = target.y;
        render.lastTileChange = now;
      }

      let moving = false;
      if (render.tweenMs > 0) {
        const t = (now - render.tweenStart) / render.tweenMs;
        if (t >= 1) {
          render.visX = render.tileX;
          render.visY = render.tileY;
        } else {
          render.visX = render.fromX + (render.tileX - render.fromX) * t;
          render.visY = render.fromY + (render.tileY - render.fromY) * t;
          moving = true;
        }
      }
      // Hold the walk cycle across the seam between consecutive steps.
      const walking = moving || now - (render.tweenStart + render.tweenMs) < 90;
      const elapsed = now - render.lastUpdate;
      render.art.moving = walking;
      if (walking) render.art.walkTime += elapsed < 100 ? elapsed : 100;
      else render.art.walkTime = 0;
      const entity = byId.get(render.id);
      if (entity) {
        paintEntityArt(render.emoji, entity, render.art, now);
        const tree = isTreeArt(entity);
        if (tree !== render.tree) {
          render.tree = tree;
          this.paintRect(render, render.id === this.localEntityId);
        }
        const label = entity.components.label;
        if (render.nameLabel && typeof label === 'string' && render.nameLabel.text !== label) {
          render.nameLabel.text = label;
        }
      }
      render.lastUpdate = now;
      render.container.position.set(render.visX * TILE_SIZE, render.visY * TILE_SIZE);
      render.container.zIndex = render.visY * TILE_SIZE + (render.kind === 'item' ? -1 : 0);
      render.emoji.alpha = local && render.tree && hides(render, local) ? 0.5 : 1;
    }

    for (const [id, target] of targets) {
      if (!this.entities.has(id)) {
        const entity = byId.get(id);
        if (!entity) continue;
        const render = this.createRenderEntity(entity);
        render.container.position.set(target.x * TILE_SIZE, target.y * TILE_SIZE);
        render.container.zIndex = target.y * TILE_SIZE;
        this.entities.set(id, render);
        this.paintRing(render);
      }
    }

    for (const [id, render] of this.entities) {
      if (render.frozenAt !== null && now - render.frozenAt > FROZEN_MS) {
        render.container.destroy({ children: true });
        this.entities.delete(id);
      } else if (render.frozenAt !== null) {
        render.container.alpha = 1 - (now - render.frozenAt) / FROZEN_MS;
      } else if (render.container.alpha !== 1) {
        render.container.alpha = 1;
      }
    }

    this.animateFloats(now, dtMs);
  }

  /** Stations with active crafting jobs get stacked progress bars. */
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
        render.craftBar.rect(2, y, width, 3).fill(0x161616);
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
   * Health bars over damaged or targeted entities, and floating numbers for
   * every hp or level change seen between snapshots.
   */
  updateHealthBars(snapshot: { entities: EntityState[] }): void {
    for (const entity of snapshot.entities) {
      const render = this.entities.get(entity.id);
      if (!render) continue;
      const stats = entity.components.stats;
      if (!isStatsComponent(stats)) {
        render.hpBar.visible = false;
        continue;
      }
      if (render.lastHp !== null && stats.hp !== render.lastHp) {
        const delta = stats.hp - render.lastHp;
        const mine = entity.id === this.localEntityId;
        if (delta < 0) {
          this.floatText(render.visX, render.visY, String(-delta), mine ? 0xff5a4e : 0xffe9a8, mine ? 15 : 16);
        } else if (delta >= 2 && stats.hp < stats.maxHp + 1) {
          this.floatText(render.visX, render.visY, `+${delta}`, 0x7ee787, 13);
        }
      }
      if (render.lastLevel !== null && stats.level > render.lastLevel) {
        this.floatText(render.visX, render.visY - 0.6, `LEVEL ${stats.level}!`, 0xffd25e, 18);
      }
      render.lastHp = stats.hp;
      render.lastLevel = stats.level;

      const show = stats.hp < stats.maxHp || entity.id === this.targetId;
      if (!show || entity.kind === 'player' && entity.id === this.localEntityId) {
        render.hpBar.visible = false;
        continue;
      }
      render.hpBar.visible = true;
      render.hpBar.clear();
      const width = TILE_SIZE - 2;
      const top = render.emoji.y - render.emoji.anchor.y * render.emoji.height;
      const y = (top < 0 ? top : 0) - 6;
      render.hpBar.roundRect(0, y, width + 2, 5, 2).fill({ color: 0x0d0a07, alpha: 0.85 });
      const raw = stats.hp / stats.maxHp;
      const frac = raw < 0 ? 0 : raw > 1 ? 1 : raw;
      const fillWidth = frac <= 0 ? 0 : ~~(width * frac + 0.5) < 2 ? 2 : ~~(width * frac + 0.5);
      const color = frac > 0.5 ? 0x6fd36a : frac > 0.25 ? 0xe5c07b : 0xe06c75;
      render.hpBar.rect(1, y + 1, fillWidth, 3).fill(color);
    }
  }

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
