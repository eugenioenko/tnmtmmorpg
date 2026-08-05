import { Texture } from 'pixi.js';

/**
 * Emoji texture baker: renders one emoji per entity kind onto a tiny
 * offscreen canvas and caches the resulting Pixi texture. This gives every
 * entity kind a placeholder sprite with zero art pipeline — later phases
 * (and features) register their kinds' glyphs via `registerEmoji`.
 */

const DEFAULT_EMOJI = '⬜';

const FONT_SIZE = 32; // texture size in px; sprites scale it to the tile
const TEXTURE_CACHE = new Map<string, Texture>();

const EMOJI_BY_KIND = new Map<string, string>([
  ['player', '🧙'],
  ['container', '📦'], // Phase 5: chests are a core entity kind
  ['npc', '🤖'], // core entity kind: wandering NPCs (features may register their own)
]);

/** Glyphs for item ids; features can add more via registerItemEmoji. */
const EMOJI_BY_ITEM = new Map<string, string>([
  ['_example:herb', '🌿'],
  ['_example:vial', '🧪'],
  ['_example:stone', '🪨'],
]);

/** Fallback: an item's first known tag decides its glyph. */
const TAG_EMOJI: Record<string, string> = {
  herb: '🌿',
  plant: '🌿',
  vial: '🧪',
  glass: '🧪',
  stone: '🪨',
  mineral: '🪨',
};

const ITEM_FALLBACK_EMOJI = '❔';

/** The glyph for an entity kind, falling back to a placeholder box. */
export function emojiForKind(kind: string): string {
  return EMOJI_BY_KIND.get(kind) ?? DEFAULT_EMOJI;
}

/** Feature code can map a new entity kind to a glyph at boot time. */
export function registerEmoji(kind: string, emoji: string): void {
  EMOJI_BY_KIND.set(kind, emoji);
}

/**
 * The glyph for an item: exact id match first, then the item's first known
 * tag, then a question mark. Tags are the interop primitive, so items from
 * features with no atlas entry still get a sensible glyph.
 */
export function emojiForItem(itemId: string, tags: readonly string[] = []): string {
  const direct = EMOJI_BY_ITEM.get(itemId);
  if (direct) return direct;
  for (const tag of tags) {
    const glyph = TAG_EMOJI[tag];
    if (glyph) return glyph;
  }
  return ITEM_FALLBACK_EMOJI;
}

/** Feature code can map an item id to a glyph at boot time. */
export function registerItemEmoji(itemId: string, emoji: string): void {
  EMOJI_BY_ITEM.set(itemId, emoji);
}

/**
 * Bake an emoji into a reusable Pixi texture. Textures are cached forever;
 * the canvas stays alive for the lifetime of the page (the texture source
 * holds a reference to it), so each glyph is rasterized exactly once.
 */
export function emojiTexture(emoji: string): Texture {
  const cached = TEXTURE_CACHE.get(emoji);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = FONT_SIZE;
  canvas.height = FONT_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');

  ctx.font = `${FONT_SIZE}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, FONT_SIZE / 2, FONT_SIZE / 2 + 2);

  const texture = Texture.from(canvas);
  TEXTURE_CACHE.set(emoji, texture);
  return texture;
}
