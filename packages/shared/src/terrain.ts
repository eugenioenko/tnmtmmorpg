/**
 * Terrain: the 8 tile kinds, their wire bytes, client colors and
 * walkability. The binary protocol (binary.ts) encodes tile kinds through
 * TILE_KIND_BYTE (kind string -> byte); byte 255 is reserved there as an
 * escape for kinds not listed, so the table can grow without a wire-format
 * change.
 */

// Tile kinds
export const TILE_GRASS = 0;
export const TILE_WATER = 1;
export const TILE_MOUNTAIN = 2;
export const TILE_SAND = 3;
export const TILE_FOREST = 4;
export const TILE_DIRT = 5;
export const TILE_SNOW = 6;
export const TILE_SWAMP = 7;

// Byte → string for wire protocol (the binary decoder's table)
export const TILE_KIND_BYTE: Record<number, string> = {
  [TILE_GRASS]: 'grass',
  [TILE_WATER]: 'water',
  [TILE_MOUNTAIN]: 'mountain',
  [TILE_SAND]: 'sand',
  [TILE_FOREST]: 'forest',
  [TILE_DIRT]: 'dirt',
  [TILE_SNOW]: 'snow',
  [TILE_SWAMP]: 'swamp',
};

// Byte → string, same table; kept under the historical name so the binary
// decoder's import (`TILE_KIND_BY_BYTE[byte]`) keeps working unchanged.
export const TILE_KIND_BY_BYTE: Record<number, string> = TILE_KIND_BYTE;

// String → byte (the binary encoder's table and client lookups)
export const TILE_BYTE_BY_KIND: Record<string, number> = {
  grass: TILE_GRASS,
  water: TILE_WATER,
  mountain: TILE_MOUNTAIN,
  sand: TILE_SAND,
  forest: TILE_FOREST,
  dirt: TILE_DIRT,
  snow: TILE_SNOW,
  swamp: TILE_SWAMP,
};

// Which tiles you can walk on (water and mountain block movement)
export const WALKABLE_TILES: Set<number> = new Set([
  TILE_GRASS,
  TILE_SAND,
  TILE_FOREST,
  TILE_DIRT,
  TILE_SNOW,
  TILE_SWAMP,
]);

// Client colors
export const TILE_COLORS: Record<number, number> = {
  [TILE_GRASS]: 0x5ea83c,
  [TILE_WATER]: 0x4a90d9,
  [TILE_MOUNTAIN]: 0x8b8682,
  [TILE_SAND]: 0xe8d5a3,
  [TILE_FOREST]: 0x4a8c2a,
  [TILE_DIRT]: 0x9b7b5c,
  [TILE_SNOW]: 0xe8f0f8,
  [TILE_SWAMP]: 0x5c7a3e,
};

// Human-readable names for debug/logging
export const TILE_NAMES: Record<number, string> = {
  [TILE_GRASS]: 'grass',
  [TILE_WATER]: 'water',
  [TILE_MOUNTAIN]: 'mountain',
  [TILE_SAND]: 'sand',
  [TILE_FOREST]: 'forest',
  [TILE_DIRT]: 'dirt',
  [TILE_SNOW]: 'snow',
  [TILE_SWAMP]: 'swamp',
};
