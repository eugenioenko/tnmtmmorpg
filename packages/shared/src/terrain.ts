/**
 * Terrain: the tile kinds, their wire bytes, client colors and walkability.
 * The binary protocol (binary.ts) encodes tile kinds through TILE_KIND_BYTE
 * (kind string -> byte); byte 255 is reserved there as an escape for kinds
 * not listed, so the table can grow without a wire-format change.
 *
 * Bytes 0-7 are outdoor terrain, produced by the noise generator. Bytes 8-10
 * are interior building blocks, produced by the room generator instead:
 * interiors are carved rooms surrounded by VOID, which renders black and
 * blocks movement, so a building reads as a lit room in an unlit space
 * rather than a patch of countryside.
 *
 * Colors here are the OVERWORLD palette. Other worlds re-skin the same bytes
 * through PALETTES in worlds.ts — a fire world draws byte 1 as lava rather
 * than water, while collision stays byte-based and identical everywhere.
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
/** Interior: unreachable nothing outside a room. Black, never walkable. */
export const TILE_VOID = 8;
/** Interior: the walkable floor of a room. */
export const TILE_FLOOR = 9;
/** Interior: the wall enclosing a room. Blocks movement. */
export const TILE_WALL = 10;
/** Built over water by players: walkable planks, drawn over the water beneath. */
export const TILE_BRIDGE = 11;

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
  [TILE_VOID]: 'void',
  [TILE_FLOOR]: 'floor',
  [TILE_WALL]: 'wall',
  [TILE_BRIDGE]: 'bridge',
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
  void: TILE_VOID,
  floor: TILE_FLOOR,
  wall: TILE_WALL,
  bridge: TILE_BRIDGE,
};

// Which tiles you can walk on (water and mountain block movement)
export const WALKABLE_TILES: Set<number> = new Set([
  TILE_GRASS,
  TILE_SAND,
  TILE_FOREST,
  TILE_DIRT,
  TILE_SNOW,
  TILE_SWAMP,
  TILE_FLOOR,
  TILE_BRIDGE,
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
  [TILE_VOID]: 0x000000,
  [TILE_FLOOR]: 0x6b5a48,
  [TILE_WALL]: 0x3b3129,
  [TILE_BRIDGE]: 0x9a6a3a,
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
  [TILE_VOID]: 'void',
  [TILE_FLOOR]: 'floor',
  [TILE_WALL]: 'wall',
  [TILE_BRIDGE]: 'bridge',
};

// ── Viewport: the single source of truth for how much world a client sees ──
// The server sends a fixed window of tiles around each player, and the client
// renders exactly that much. These MUST agree: when the client's drawn range
// was derived from the browser window instead, anything past the server's
// window fell back to grass and then snapped to real terrain as the player
// walked into it — a flicker along whichever edge was leading.
//
// A fixed window also keeps the game fair. On a shared world a 4K monitor
// would otherwise reveal several times more of the map than a laptop.

/** World tile edge in pixels. */
export const TILE_SIZE = 32;
/**
 * Tiles the server sends either side of the player. This is deliberately
 * WIDER than the canvas shows: the surplus is what the camera pans into.
 * Without a margin the camera could only look at ground the client was
 * never sent, which renders as fallback grass.
 */
export const VIEW_RADIUS_X = 36;
export const VIEW_RADIUS_Y = 26;

/** Tiles the canvas actually displays either side of centre. */
export const VISIBLE_RADIUS_X = 27;
export const VISIBLE_RADIUS_Y = 17;

/**
 * Tiles the renderer samples beyond the visible edge. The marching-squares
 * corner test reads one tile out, so the outermost visible tiles need drawn
 * neighbours to cut their diagonals against.
 */
export const VIEW_HALO = 3;

/**
 * Largest canvas that stays inside the tiles the server sends, in CSS px.
 * The viewport is capped here rather than filling the window: beyond this
 * the client would be drawing ground it was never told about.
 */
export const MAX_VIEW_WIDTH = (2 * VISIBLE_RADIUS_X + 1) * TILE_SIZE;
export const MAX_VIEW_HEIGHT = (2 * VISIBLE_RADIUS_Y + 1) * TILE_SIZE;

/**
 * How far free-look may move the view off the player, in TILES. The server
 * centres snapshots on the reported camera and clamps to this same number,
 * so it is a gameplay limit (how far you may peek) rather than a rendering
 * one. The server's radius only has to exceed the visible radius by enough
 * to absorb the lag between the client moving its camera and the next
 * snapshot arriving.
 */
export const MAX_VIEW_OFFSET = 10;
export const MAX_PAN_X = MAX_VIEW_OFFSET * TILE_SIZE;
export const MAX_PAN_Y = MAX_VIEW_OFFSET * TILE_SIZE;
