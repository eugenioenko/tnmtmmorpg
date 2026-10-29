import { Assets, ColorMatrixFilter, Rectangle, Texture, type Sprite } from 'pixi.js';
import { TILE_KIND_BY_BYTE, type EntityState } from '@game/shared';
import atlas from './art/harvest-moon/atlas.json' with { type: 'json' };
import atlasUrl from './art/harvest-moon/atlas.png';
import { emojiTexture } from './emoji-atlas.ts';

// All frames share one GPU source. This is the only skin-specific adapter;
// replace the atlas and mappings here when the final artwork arrives.
type Frame = [number, number, number, number, number, number];
const frames = atlas.frames as Record<string, number[]>;
const animations = atlas.animations as Record<string, { frame: string; ticks: number }[]>;
const terrain = atlas.terrain as Record<string, string[]>;
const textures = new Map<string, Texture>();
let source: Texture | null = null;

export async function loadArt(): Promise<void> {
  try {
    source = await Assets.load<Texture>(atlasUrl);
    source.source.scaleMode = 'nearest';
    bakeStump(source);
  } catch (error) {
    console.error('Temporary artwork failed to load; using the original graphics.', error);
  }
}

/** A felled tree: the roots of the tree art with a fresh-cut face on top. */
function bakeStump(atlasTexture: Texture): void {
  const image = atlasTexture.source.resource as CanvasImageSource;
  const [x, y] = frames['objects/tree'];
  const canvas = document.createElement('canvas');
  canvas.width = 36;
  canvas.height = 21;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, x + 6, y + 47, 36, 17, 0, 4, 36, 17);
  const face = (rx: number, ry: number, color: string, cy = 5): void => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(17.5, cy, rx, ry, 0, 0, 6.2832);
    ctx.fill();
  };
  face(10, 4, '#4a2f18', 6);
  face(9, 3.2, '#dcae6c');
  face(5.5, 1.8, '#b98446');
  face(2.5, 0.8, '#e8c486');
  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'nearest';
  textures.set('objects/tree-stump', texture);
  frames['objects/tree-stump'] = [0, 0, 36, 21, 0, 0];
}

export function artTexture(name: string): Texture | undefined {
  if (!source || !frames[name]) return undefined;
  let texture = textures.get(name);
  if (!texture) {
    const [x, y, w, h] = frames[name];
    texture = new Texture({ source: source.source, frame: new Rectangle(x, y, w, h) });
    textures.set(name, texture);
  }
  return texture;
}

export function terrainTexture(byte: number, phase = 0): Texture | undefined {
  const names = terrain[TILE_KIND_BY_BYTE[byte]];
  return names && artTexture(names[phase % names.length]);
}

/**
 * Depth (source px) of a feathered edge along its 16 pixels. Every profile
 * starts and ends at the same depth so neighbouring tiles join seamlessly,
 * and tiles pick among them by position so long borders never repeat.
 */
const PROFILES = [
  [4, 4, 5, 6, 8, 9, 9, 8, 6, 5, 5, 6, 7, 6, 5, 4],
  [4, 5, 6, 6, 5, 4, 3, 3, 4, 6, 8, 9, 8, 6, 5, 4],
  [4, 3, 3, 4, 6, 8, 10, 10, 9, 7, 5, 4, 4, 5, 5, 4],
  [4, 5, 7, 8, 8, 7, 5, 4, 3, 3, 4, 5, 6, 6, 5, 4],
];
const blends = new Map<string, Texture | null>();

/**
 * Where a higher terrain feathers into this tile. Each edge in `mask` (bits
 * as in the tilemap: N, E, S, W, then the diagonals) becomes a wavy band,
 * inner corners are filleted and lone diagonals become rounded nubs, so
 * borders read as organic rather than as a staircase of tiles.
 */
function blendCovers(mask: number, variant: number, x: number, y: number): boolean {
  const cx = x + 0.5;
  const cy = y + 0.5;
  const n = cy;
  const e = 16 - cx;
  const s = 16 - cy;
  const w = cx;
  const dN = PROFILES[variant & 3][x];
  const dE = PROFILES[(variant >> 2) & 3][y];
  const dS = PROFILES[(variant >> 4) & 3][15 - x];
  const dW = PROFILES[(variant >> 6) & 3][15 - y];
  if (mask & 1 && n < dN) return true;
  if (mask & 2 && e < dE) return true;
  if (mask & 4 && s < dS) return true;
  if (mask & 8 && w < dW) return true;
  const fillet = (a: number, b: number, da: number, db: number): boolean => {
    const r = 3;
    const fa = a - da;
    const fb = b - db;
    return fa >= 0 && fb >= 0 && fa < r && fb < r && (r - fa) * (r - fa) + (r - fb) * (r - fb) > r * r;
  };
  if (mask & 1 && mask & 2 && fillet(n, e, dN, dE)) return true;
  if (mask & 2 && mask & 4 && fillet(e, s, dE, dS)) return true;
  if (mask & 4 && mask & 8 && fillet(s, w, dS, dW)) return true;
  if (mask & 8 && mask & 1 && fillet(w, n, dW, dN)) return true;
  const nub = (a: number, b: number): boolean => a * a + b * b < 38;
  if (mask & 16 && nub(n, w)) return true;
  if (mask & 32 && nub(n, e)) return true;
  if (mask & 64 && nub(s, e)) return true;
  if (mask & 128 && nub(s, w)) return true;
  return false;
}

/** Baked at the on-screen tile size: Graphics fills map a canvas texture one to one. */
const BLEND_PX = 32;

function bakeBlend(byte: number, mask: number, variant: number): Texture | null {
  const base = terrainTexture(byte);
  if (!base || !source) return null;
  const frame = base.frame;
  const canvas = document.createElement('canvas');
  canvas.width = BLEND_PX;
  canvas.height = BLEND_PX;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;
  const image = source.source.resource as CanvasImageSource;
  ctx.drawImage(image, frame.x, frame.y, 16, 16, 0, 0, BLEND_PX, BLEND_PX);
  const img = ctx.getImageData(0, 0, BLEND_PX, BLEND_PX);
  const px = img.data;
  const covered: boolean[] = [];
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) covered.push(blendCovers(mask, variant, x, y));
  const at = (x: number, y: number): boolean => x < 0 || y < 0 || x > 15 || y > 15 || covered[y * 16 + x];
  const k = BLEND_PX / 16;
  for (let y = 0; y < BLEND_PX; y++) {
    for (let x = 0; x < BLEND_PX; x++) {
      const sx = (x / k) | 0;
      const sy = (y / k) | 0;
      const i = (y * BLEND_PX + x) * 4;
      if (!covered[sy * 16 + sx]) {
        px[i + 3] = 0;
      } else if (!at(sx + 1, sy) || !at(sx - 1, sy) || !at(sx, sy + 1) || !at(sx, sy - 1)) {
        px[i] = (px[i] * 0.72) | 0;
        px[i + 1] = (px[i + 1] * 0.72) | 0;
        px[i + 2] = (px[i + 2] * 0.72) | 0;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'nearest';
  return texture;
}

/** `variant` picks the edge profiles (two bits per edge); pass a stable per-tile hash. */
export function transitionTexture(byte: number, mask: number, variant = 0): Texture | undefined {
  const key = `${byte}:${mask}:${variant & 255}`;
  let texture = blends.get(key);
  if (texture === undefined) {
    texture = bakeBlend(byte, mask, variant & 255);
    blends.set(key, texture);
  }
  return texture ?? artTexture(`transitions/${TILE_KIND_BY_BYTE[byte]}/${mask}`);
}

/** Stable scrambled selection: every browser agrees on each player's outfit. */
export function characterIndex(id: number): number {
  let hash = id | 0;
  hash = ((hash >>> 16) ^ hash) * 0x45d9f3b;
  hash = ((hash >>> 16) ^ hash) * 0x45d9f3b;
  return (((hash >>> 16) ^ hash) >>> 0) % atlas.characters.length;
}

export interface ArtState {
  facing: 'south' | 'north' | 'east' | 'west';
  walkTime: number;
  moving: boolean;
}

const OBJECTS: Record<string, string | number> = {
  'nature:tree': 'objects/tree',
  'nature:bush': 300,
  container: 347,
  '_example:totem': 'objects/boulder',
  '_example:workbench': 'objects/well',
  'buildings:door': 'objects/door',
  'buildings:exit': 'objects/door',
  'portals:pad': 'objects/portal-base',
  'portals:return': 'objects/portal-base',
};

/** Optional atlas appearance supplied by content features, in source pixels. */
export interface Appearance {
  frame?: string;
  /** A walking creature from CREATURES, animated and facing like a character. */
  creature?: string;
  /** A named character set from the atlas, instead of the id-derived outfit. */
  character?: string;
  scale?: number;
  originX?: number;
  originY?: number;
  tint?: number;
  /** Grey the art out before tinting, so a yellow dog can become a grey wolf. */
  desaturate?: boolean;
  marker?: number;
  /** Draw this emoji, standing on the tile, instead of atlas art; `scale` sizes it. */
  emoji?: string;
}

const tintFilters = new Map<number, ColorMatrixFilter>();

/** Luminance first, then the tint: a recolour rather than a multiply. */
function recolour(tint: number): ColorMatrixFilter {
  let filter = tintFilters.get(tint);
  if (!filter) {
    const r = ((tint >> 16) & 255) / 255;
    const g = ((tint >> 8) & 255) / 255;
    const b = (tint & 255) / 255;
    const k = 1.25;
    filter = new ColorMatrixFilter();
    filter.matrix = [
      0.3 * r * k, 0.59 * r * k, 0.11 * r * k, 0, 0,
      0.3 * g * k, 0.59 * g * k, 0.11 * g * k, 0, 0,
      0.3 * b * k, 0.59 * b * k, 0.11 * b * k, 0, 0,
      0, 0, 0, 1, 0,
    ];
    tintFilters.set(tint, filter);
  }
  return filter;
}

export function entityAppearance(entity: EntityState): Appearance | undefined {
  const appearance = entity.components.appearance;
  if (typeof appearance !== 'object' || appearance === null) return undefined;
  const spec = appearance as Appearance;
  return typeof spec.frame === 'string' ||
    typeof spec.emoji === 'string' ||
    typeof spec.creature === 'string' ||
    typeof spec.character === 'string'
    ? spec
    : undefined;
}

interface DirectionalSet {
  /** South, north and side animation ids; side frames face west in the ROM. */
  walk: number[];
  idle: number[];
}

/** Animal animation sets, used as tinted stand-ins for monsters. */
const CREATURES: Record<string, DirectionalSet> = {
  dog: { walk: [474, 481, 489], idle: [473, 480, 488] },
  sheep: { walk: [450, 452, 443], idle: [449, 451, 442] },
  chicken: { walk: [530, 530, 530], idle: [533, 533, 533] },
};

const charactersById = new Map(atlas.characters.map((set) => [set.id, set]));

function directionalSet(entity: EntityState, appearance: Appearance | undefined) {
  if (appearance?.creature) return CREATURES[appearance.creature];
  if (appearance?.character) return charactersById.get(appearance.character);
  if (entity.kind === 'player' || entity.kind === 'npc') {
    return atlas.characters[characterIndex(entity.id)];
  }
  return undefined;
}
const ITEMS: Record<string, number> = {
  '_example:herb': 300,
  '_example:stone': 280,
  '_example:vial': 269,
  '_example:glowing_essence': 269,
  '_example:polished_stone': 280,
  'farming:seed': 329,
};

function animationFrame(id: number, elapsed: number): string | undefined {
  const seq = animations[String(id)];
  if (!seq?.length) return undefined;
  // ROM ticks are 60 Hz. Holding frames use 255 rather than a duration.
  const total = seq.reduce((sum, frame) => sum + (frame.ticks === 255 ? 60 : frame.ticks), 0);
  let tick = ((elapsed * 60) / 1000) % total;
  for (const frame of seq) {
    tick -= frame.ticks === 255 ? 60 : frame.ticks;
    if (tick < 0) return frame.frame;
  }
  return seq[0].frame;
}

export interface PortraitFrame {
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
  tint?: number;
}

/** The south-facing idle frame of an actor, for CSS-drawn HUD portraits. */
export function portraitFrame(entity: EntityState): PortraitFrame | undefined {
  const appearance = entityAppearance(entity);
  const set = directionalSet(entity, appearance);
  if (!set) return undefined;
  const name = animationFrame(set.idle[0], 0);
  const rect = name ? frames[name] : undefined;
  if (!rect) return undefined;
  return { url: atlasUrl, x: rect[0], y: rect[1], w: rect[2], h: rect[3], tint: appearance?.tint };
}

/** Atlas frame of an item icon, when the skin has one. */
export function itemFrame(itemId: string): PortraitFrame | undefined {
  const id = ITEMS[itemId];
  const name = id === undefined ? undefined : animationFrame(id, 0);
  const rect = name ? frames[name] : undefined;
  if (!rect) return undefined;
  return { url: atlasUrl, x: rect[0], y: rect[1], w: rect[2], h: rect[3] };
}

/** Whether an entity is drawn as a tree (and so grows, sways and casts a wide shadow). */
export function isTreeArt(entity: EntityState): boolean {
  const appearance = entityAppearance(entity);
  if (appearance?.emoji) return false;
  return (appearance?.frame ?? OBJECTS[entity.kind]) === 'objects/tree';
}

const TREE_TINTS = [0xffffff, 0xeaf6dc, 0xf4ffe6, 0xdcefcf, 0xfff0d2, 0xe4f0e8];

function scramble(id: number, salt: number): number {
  let h = (id * 2654435761 + salt * 40503) | 0;
  h = ((h >>> 16) ^ h) * 0x45d9f3b;
  h = ((h >>> 16) ^ h) * 0x45d9f3b;
  return (((h >>> 16) ^ h) >>> 0) / 4294967296;
}

/** A sine-like swing in -1..1 with period 1. */
function swing(t: number): number {
  const p = t - (t | 0);
  const tri = 4 * (p < 0.5 ? 0.5 - p : p - 0.5) - 1;
  return tri * (1.5 - 0.5 * tri * tri);
}

/**
 * Trees are drawn larger than their source art, each a little different in
 * size and leaf colour, rooted at the tile and leaning with the wind.
 */
function paintTree(sprite: Sprite, entity: EntityState, scale: number, tinted: boolean, now: number): void {
  const grown = scale * (1.5 + scramble(entity.id, 1) * 0.45);
  sprite.anchor.set(0.5, 1);
  sprite.scale.set(scramble(entity.id, 2) < 0.5 ? -grown : grown, grown);
  sprite.position.set(16, 30);
  if (!tinted) sprite.tint = TREE_TINTS[(scramble(entity.id, 3) * TREE_TINTS.length) | 0];
  const gust = 0.5 + 0.5 * swing(now / 9000 + entity.x * 0.013);
  sprite.skew.set(0.035 * gust * swing(now / 2600 + scramble(entity.id, 4)), 0);
}

/** Update art without creating textures, sprites, or canvases every frame. */
export function paintEntityArt(
  sprite: Sprite,
  entity: EntityState,
  state: ArtState,
  now: number,
): boolean {
  let name: string | undefined;
  let mirror = false;
  let scale = 1.5;
  const appearance = entityAppearance(entity);
  if (appearance?.emoji) {
    const texture = emojiTexture(appearance.emoji);
    const size = 24 * (appearance.scale ?? 1);
    if (sprite.texture !== texture) sprite.texture = texture;
    sprite.tint = 0xffffff;
    sprite.anchor.set(0, 0);
    sprite.skew.set(0, 0);
    sprite.scale.set(size / texture.width);
    sprite.position.set(16 - size / 2, 30 - size);
    return true;
  }
  const set = directionalSet(entity, appearance);
  const actor = set !== undefined;
  if (set) {
    const direction = state.facing === 'south' ? 0 : state.facing === 'north' ? 1 : 2;
    mirror = state.facing === 'east';
    const animation = (state.moving ? set.walk : set.idle)[direction];
    name = animationFrame(animation, state.moving ? state.walkTime * 1.6 : 0);
    if (appearance) scale = appearance.scale ?? scale;
  } else if (entity.kind === 'item') {
    const drop = entity.components.itemDrop as { itemId?: string } | undefined;
    const id = drop?.itemId ? ITEMS[drop.itemId] : undefined;
    if (id !== undefined) name = animationFrame(id, now);
    scale = 1;
  } else {
    const object = OBJECTS[entity.kind];
    name = typeof object === 'number' ? animationFrame(object, now) : object;
    if (entity.kind === 'nature:tree') scale = 1;
  }
  if (appearance?.frame) {
    name = appearance.frame;
    scale = appearance.scale ?? 1;
  }
  if (!name) return false;
  const texture = artTexture(name);
  if (!texture) return false;
  sprite.texture = texture;
  if (appearance?.desaturate) {
    sprite.tint = 0xffffff;
    const filter = recolour(appearance.tint ?? 0xffffff);
    if (sprite.filters?.[0] !== filter) sprite.filters = [filter];
  } else {
    sprite.tint = appearance?.tint ?? 0xffffff;
  }
  if (name === 'objects/tree') {
    paintTree(sprite, entity, scale, appearance?.tint !== undefined, now);
    return true;
  }
  sprite.anchor.set(0, 0);
  sprite.skew.set(0, 0);
  sprite.scale.set(mirror ? -scale : scale, scale);
  const [, , w, h, ox, oy] = frames[name] as Frame;
  if (appearance?.frame) {
    sprite.position.set(
      16 - (appearance.originX ?? w / 2) * scale,
      30 - (appearance.originY ?? h) * scale,
    );
  } else if (actor) {
    // Preserve the ROM's common feet origin across differently trimmed frames.
    sprite.position.set(16 + (mirror ? -ox : ox) * scale, 24 + oy * scale);
  } else {
    sprite.position.set(16 - (w * scale) / 2, 30 - h * scale);
  }
  return true;
}
