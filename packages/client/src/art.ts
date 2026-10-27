import { Assets, ColorMatrixFilter, Rectangle, Texture, type Sprite } from 'pixi.js';
import { TILE_KIND_BY_BYTE, type EntityState } from '@game/shared';
import atlas from './art/harvest-moon/atlas.json' with { type: 'json' };
import atlasUrl from './art/harvest-moon/atlas.png';

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
  } catch (error) {
    console.error('Temporary artwork failed to load; using the original graphics.', error);
  }
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

export function transitionTexture(byte: number, mask: number): Texture | undefined {
  return artTexture(`transitions/${TILE_KIND_BY_BYTE[byte]}/${mask}`);
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
  sprite.anchor.set(0, 0);
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
