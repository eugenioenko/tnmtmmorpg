/**
 * Worlds: the overworld, the themed worlds behind the central portals, and
 * the interiors behind every door.
 *
 * A world is just `{ id, width, height, seed, gen, palette }`. Terrain is a
 * pure function of (seed, chunk coords) generated lazily on first read, so an
 * unvisited world costs ZERO bytes — only chunks somebody actually walked on
 * are ever stored. That is what makes this affordable: five 10000x10000
 * worlds and thousands of building interiors do not grow the database until
 * they are visited.
 *
 * Two kinds of world:
 *
 *   static     the overworld and the four themed worlds. Declared below.
 *   generated  interiors, one per door, id 'interior:<x>,<y>', and dungeon
 *              instances, id 'dungeon:<x>,<y>/<copy>'. There is no list of
 *              these — the id encodes the entrance's position, and the spec
 *              is derived from it on demand (see resolveWorld).
 *
 * Themed worlds re-use the SAME generator and the same 8 terrain bytes; only
 * the thresholds and the palette differ. So the fire world has the shape of a
 * landscape, drawn in magma, and collision stays byte-based and identical
 * everywhere — byte 1 blocks movement whether it renders as water or lava.
 */

import {
  TILE_DIRT,
  TILE_FLOOR,
  TILE_FOREST,
  TILE_GRASS,
  TILE_MOUNTAIN,
  TILE_SAND,
  TILE_SNOW,
  TILE_SWAMP,
  TILE_VOID,
  TILE_WALL,
  TILE_WATER,
} from './terrain.ts';

/** The world every player starts in, and the id used when none is given. */
export const OVERWORLD = 'overworld';

/**
 * Thresholds the chunk generator compares its noise fields against. Raising
 * `water` floods a world; lowering `snow` freezes it. Every value is a
 * fraction of the same 0..1 noise, so these are the only knobs a themed
 * world needs — the terrain SHAPE is identical, which is the point.
 */
export interface GenParams {
  /** elevation below this is water. Overworld 0.33. */
  water: number;
  /** elevation below this (and above water) is beach. Overworld 0.43. */
  sand: number;
  /** elevation above this is mountain. Overworld 0.74. */
  mountain: number;
  /** climate above this is snow. Overworld 0.78; lower means colder. */
  snow: number;
  /** moisture above this is forest. Overworld 0.45. */
  forest: number;
  /** moisture below this is bare dirt. Overworld 0.28. */
  dirt: number;
}

export const DEFAULT_GEN: GenParams = {
  water: 0.33,
  sand: 0.43,
  mountain: 0.74,
  snow: 0.78,
  forest: 0.45,
  dirt: 0.28,
};

/** How a world's chunks are produced. */
export type GeneratorKind = 'terrain' | 'rooms' | 'caves';

export interface WorldSpec {
  id: string;
  width: number;
  height: number;
  seed: number;
  /** 'terrain' = the noise generator; 'rooms' = carved interior; 'caves' = a dungeon. */
  generator: GeneratorKind;
  gen: GenParams;
  /** Key into PALETTES; decides only how the client draws the same bytes. */
  palette: string;
  /** Shown in the client's debug panel. */
  name: string;
}

/**
 * Per-world tile colors. The wire format never changes — tiles are still
 * bytes — so a palette is purely a client-side lookup. Anything a palette
 * omits falls back to the overworld color.
 */
export type Palette = Record<number, number>;

export const PALETTES: Record<string, Palette> = {
  overworld: {
    [TILE_GRASS]: 0x5ea83c,
    [TILE_WATER]: 0x4a90d9,
    [TILE_MOUNTAIN]: 0x8b8682,
    [TILE_SAND]: 0xe8d5a3,
    [TILE_FOREST]: 0x4a8c2a,
    [TILE_DIRT]: 0x9b7b5c,
    [TILE_SNOW]: 0xe8f0f8,
    [TILE_SWAMP]: 0x5c7a3e,
  },

  // Ash plains and magma. Water becomes lava, so the "lakes" the generator
  // carves read as molten pools; snow becomes pale ash drifts.
  fire: {
    [TILE_GRASS]: 0x6b3a2a,
    [TILE_WATER]: 0xff5722,
    [TILE_MOUNTAIN]: 0x3a2b26,
    [TILE_SAND]: 0x8c5a3c,
    [TILE_FOREST]: 0x7a2f1d,
    [TILE_DIRT]: 0x4f2f22,
    [TILE_SNOW]: 0xd9b08c,
    [TILE_SWAMP]: 0x8f3b1c,
  },

  // Ocean world: mostly sea, with reefs and scattered islands.
  water: {
    [TILE_GRASS]: 0x2e8b74,
    [TILE_WATER]: 0x1b5f9e,
    [TILE_MOUNTAIN]: 0x5a7a8c,
    [TILE_SAND]: 0xd8cfa0,
    [TILE_FOREST]: 0x1f6f5c,
    [TILE_DIRT]: 0x6b6f57,
    [TILE_SNOW]: 0xcfe8f0,
    [TILE_SWAMP]: 0x2a6f6a,
  },

  // Frozen world: everything under snow, water reads as pack ice.
  snow: {
    [TILE_GRASS]: 0xdce8ee,
    [TILE_WATER]: 0x8fbcd4,
    [TILE_MOUNTAIN]: 0x9aa7b0,
    [TILE_SAND]: 0xe4ecf2,
    [TILE_FOREST]: 0x5f7f7a,
    [TILE_DIRT]: 0xa9b4ba,
    [TILE_SNOW]: 0xffffff,
    [TILE_SWAMP]: 0x7f9aa0,
  },

  // Overgrown world: dense canopy, warm and wet.
  verdant: {
    [TILE_GRASS]: 0x3f9142,
    [TILE_WATER]: 0x2f7f6f,
    [TILE_MOUNTAIN]: 0x6b7a52,
    [TILE_SAND]: 0xc8bf7a,
    [TILE_FOREST]: 0x1f5f22,
    [TILE_DIRT]: 0x6b5a32,
    [TILE_SNOW]: 0xdfeccc,
    [TILE_SWAMP]: 0x2f6a2a,
  },

  // Interiors: only the three interior bytes matter; everything else is void
  // because the room generator never emits outdoor terrain.
  interior: {
    [TILE_VOID]: 0x000000,
    [TILE_FLOOR]: 0x6b5a48,
    [TILE_WALL]: 0x3b3129,
  },

  // Caves: packed earth under rock, drawn with the outdoor dirt and stone art.
  cave: {
    [TILE_VOID]: 0x000000,
    [TILE_FLOOR]: 0x8a7d70,
    [TILE_WALL]: 0x6d6258,
  },
};

/** Worlds carved out of nothing (interiors, caves): unsent ground is void, not grass. */
export function isCarvedWorld(spec: WorldSpec | undefined): boolean {
  return spec !== undefined && spec.generator !== 'terrain';
}

/** Colour for a tile byte in a palette, falling back to the overworld. */
export function paletteColor(palette: string, byte: number): number {
  const table = PALETTES[palette] ?? PALETTES.overworld;
  return table[byte] ?? PALETTES.overworld[byte] ?? 0x000000;
}

const WORLD_SIZE = 10000;

/**
 * The four themed worlds, reached by portals at the exact centre of the
 * overworld. Each has its own seed, so the landscape is genuinely different
 * rather than the same map recoloured.
 */
export const STATIC_WORLDS: readonly WorldSpec[] = [
  {
    id: OVERWORLD,
    name: 'Overworld',
    width: WORLD_SIZE,
    height: WORLD_SIZE,
    seed: 42,
    generator: 'terrain',
    gen: DEFAULT_GEN,
    palette: 'overworld',
  },
  {
    id: 'fire',
    name: 'The Cinder Waste',
    width: WORLD_SIZE,
    height: WORLD_SIZE,
    seed: 1337,
    generator: 'terrain',
    // Little standing liquid, and high ground everywhere: a cracked, raised
    // waste rather than a landscape with lakes.
    gen: { ...DEFAULT_GEN, water: 0.18, sand: 0.3, mountain: 0.66, snow: 0.99, dirt: 0.45 },
    palette: 'fire',
  },
  {
    id: 'water',
    name: 'The Drowned Reach',
    width: WORLD_SIZE,
    height: WORLD_SIZE,
    seed: 2024,
    generator: 'terrain',
    // Sea level far above the overworld's: most of the map floods, leaving
    // island chains along what used to be the ridges.
    gen: { ...DEFAULT_GEN, water: 0.62, sand: 0.68, mountain: 0.88, snow: 0.99 },
    palette: 'water',
  },
  {
    id: 'snow',
    name: 'The White Silence',
    width: WORLD_SIZE,
    height: WORLD_SIZE,
    seed: 7,
    generator: 'terrain',
    // Snow line dropped to near sea level, so almost everything freezes.
    gen: { ...DEFAULT_GEN, snow: 0.2, water: 0.28, forest: 0.62 },
    palette: 'snow',
  },
  {
    id: 'verdant',
    name: 'The Green Deep',
    width: WORLD_SIZE,
    height: WORLD_SIZE,
    seed: 909,
    generator: 'terrain',
    // Wet and warm: forest almost everywhere, barely any bare ground.
    gen: { ...DEFAULT_GEN, forest: 0.22, dirt: 0.08, snow: 0.99, water: 0.3 },
    palette: 'verdant',
  },
];

/** Where the portals sit: the exact centre of every world. */
export const WORLD_CENTER_X = WORLD_SIZE / 2;
export const WORLD_CENTER_Y = WORLD_SIZE / 2;

/** Ids of the themed worlds, in portal order. */
export const THEMED_WORLD_IDS: readonly string[] = ['fire', 'water', 'snow', 'verdant'];

// ── interiors ──────────────────────────────────────────────────────────────

/** Interiors are square and small — a building is one screen, not a region. */
export const INTERIOR_SIZE = 48;

/** The world id for the interior behind a door at overworld (x, y). */
export function interiorWorldId(doorX: number, doorY: number): string {
  return `interior:${doorX},${doorY}`;
}

/** True for ids produced by interiorWorldId. */
export function isInteriorWorldId(id: string): boolean {
  return id.startsWith('interior:');
}

/**
 * Derive an interior's spec from its id. There is no registry of these: the
 * id carries the door position, which seeds the layout, so the same door
 * always opens onto the same room without anything being stored.
 */
export function interiorSpec(id: string): WorldSpec | undefined {
  if (!isInteriorWorldId(id)) return undefined;
  const body = id.slice('interior:'.length);
  const comma = body.indexOf(',');
  if (comma < 0) return undefined;
  const x = Number(body.slice(0, comma));
  const y = Number(body.slice(comma + 1));
  if (!Number.isInteger(x) || !Number.isInteger(y)) return undefined;
  // Hash the door position into a seed; any two doors differ, and the same
  // door is stable across restarts.
  const seed = (((x * 374761393 + y * 668265263) ^ 0x5f356495) >>> 0) || 1;
  return {
    id,
    name: 'Interior',
    width: INTERIOR_SIZE,
    height: INTERIOR_SIZE,
    seed,
    generator: 'rooms',
    gen: DEFAULT_GEN,
    palette: 'interior',
  };
}

// ── dungeons ───────────────────────────────────────────────────────────────

/** A cave is one chunk: a chain of chambers ending in the deepest one. */
export const DUNGEON_SIZE = 64;

/** Where a cave's entrance chamber is guaranteed to have floor: arrivals land here. */
export const DUNGEON_ENTRY = { x: 8, y: 32 } as const;

/**
 * The world id for one copy of the cave whose entrance is at overworld
 * (x, y). Every copy of a cave shares its layout (the seed comes from the
 * entrance alone) so a party that splits up still knows the way; `copy`
 * only keeps groups apart.
 */
export function dungeonWorldId(entranceX: number, entranceY: number, copy: number): string {
  return `dungeon:${entranceX},${entranceY}/${copy}`;
}

export function isDungeonWorldId(id: string): boolean {
  return id.startsWith('dungeon:');
}

export function dungeonSpec(id: string): WorldSpec | undefined {
  if (!isDungeonWorldId(id)) return undefined;
  const match = /^dungeon:(-?\d+),(-?\d+)\/(\d+)$/.exec(id);
  if (!match) return undefined;
  const x = Number(match[1]);
  const y = Number(match[2]);
  const seed = (((x * 2246822519 + y * 3266489917) ^ 0x2c1b3c6d) >>> 0) || 1;
  return {
    id,
    name: 'Cave',
    width: DUNGEON_SIZE,
    height: DUNGEON_SIZE,
    seed,
    generator: 'caves',
    gen: DEFAULT_GEN,
    palette: 'cave',
  };
}

const STATIC_BY_ID = new Map(STATIC_WORLDS.map((w) => [w.id, w]));

/**
 * The spec for a world id: a declared world, or an interior or dungeon
 * derived from its id, or undefined for an id nobody minted.
 */
export function resolveWorld(id: string): WorldSpec | undefined {
  return STATIC_BY_ID.get(id) ?? interiorSpec(id) ?? dungeonSpec(id);
}
