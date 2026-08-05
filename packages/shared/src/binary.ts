/**
 * Compact binary wire format for server -> client messages.
 *
 * JSON snapshots are verbose: `{"x":5123,"y":8765}` costs 20 bytes for two
 * numbers, and a 61x41 viewport resends every entity and every changed tile
 * per tick at 10Hz. This codec packs the same data into fixed-width
 * little-endian integers — two coordinates that took 20 bytes of JSON take 4.
 *
 *   [1 byte: message type][payload]
 *
 *   Message types:
 *     0x01 FullSnapshot    0x02 DeltaSnapshot    0x03 Welcome
 *     0x04 Pong            0x05 RecipesMessage
 *
 * Everything is little-endian; strings are UTF-8. Out-of-range values THROW
 * rather than silently truncate: a corrupted id or coordinate is worse than a
 * dropped snapshot.
 *
 * Field widths follow one rule — **anything that counts upward forever is
 * uint32; anything bounded by the world or the viewport stays uint16.**
 * Both uint32 fields below were uint16 once, on the assumption that they
 * "grow slowly". They do not, and neither MUST be narrowed again:
 *
 *   tick       at 10Hz a uint16 tick overflows after 65535 ticks — 1h49m of
 *              uptime. Past that every snapshot threw on encode, so clients
 *              stopped receiving updates and the world looked frozen while
 *              the server ticked on happily. uint32 lasts ~13.6 years.
 *
 *   entity id  comes from a counter restored as MAX(id)+1, so unlike the tick
 *              a restart does NOT reset it. Observed growth on the live world
 *              was ~314 ids/hour, which exhausts a uint16 in about 8 days and
 *              cannot be worked around once reached. uint32 lasts centuries.
 *
 * Coordinates stay uint16 deliberately: x and y ride on every entity and
 * every tile of every snapshot, so widening them would inflate the hottest
 * field in the format. They are bounded instead — the server refuses to boot
 * with a world larger than 65536 on a side (see index.ts).
 *
 * Payload layouts (see each encodeX/decodeX pair):
 *   FullSnapshot   tick u32, playerX u16, playerY u16, entityCount u16,
 *                  entities, tileCount u16, tiles, disabledFeatures
 *   DeltaSnapshot  tick u32, playerX u16, playerY u16, entityCount u16,
 *                  entities, removedEntityCount u16 + u32 ids, tileCount u16,
 *                  tiles, removedTileCount u16 + coords, disabledFeatures
 *   Welcome        entityId u32, color string
 *   Pong           ts float64
 *   RecipesMessage recipeCount u16, recipes
 *
 *   entity         id u32, kind string, x u16, y u16, componentCount u8,
 *                  (key string, JSON blob)*
 *   tile           x u16, y u16, kind byte
 *   kind byte      TILE_BYTE_BY_KIND[kind]; 255 is an escape: the next bytes
 *                  are a string, for kinds the table does not know yet
 *   disabledFeatures  count u8, then count length-prefixed names (absent
 *                  when the snapshot has none — the client renders no banner)
 *   recipe         id string, station string, ticks u16, inputCount u16,
 *                  inputs, outputCount u16, outputs
 *   recipe input   kind byte (0=none, 1=tag, 2=id), value string, count u16
 *   recipe output  id string, count u16
 *
 * Strings are length-prefixed: 1 byte for short strings (entity kinds,
 * component keys, colors, recipe ids), 2 bytes for the JSON blobs.
 */

import {
  TILE_BYTE_BY_KIND,
  TILE_KIND_BY_BYTE,
  TILE_SIZE,
  VIEW_RADIUS_X,
  VIEW_RADIUS_Y,
  type DeltaSnapshot,
  type EntityState,
  type FullSnapshot,
  type Pong,
  type RecipeDef,
  type RecipeInput,
  type RecipesMessage,
  type ServerMessage,
  type TileState,
  type WelcomeMessage,
} from './index.ts';

/** Message type bytes (see the header comment). */
export const MSG_FULL = 0x01;
export const MSG_DELTA = 0x02;
export const MSG_WELCOME = 0x03;
export const MSG_PONG = 0x04;
export const MSG_RECIPES = 0x05;

/** Escape kind byte: the tile kind that follows is a length-prefixed string. */
const TILE_KIND_ESCAPE = 255;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Appends little-endian bytes to a growable array; `toBuffer` materializes
 * them. Throws RangeError on out-of-range values instead of wrapping, so a
 * coordinate or id that outgrows its field fails loudly on the server
 * (caught per-session in broadcast) rather than silently corrupting the
 * stream.
 */
export class BinaryEncoder {
  private bytes: number[] = [];

  writeU8(v: number): void {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) {
      throw new RangeError(`writeU8: ${v} does not fit in a uint8`);
    }
    this.bytes.push(v);
  }

  writeU16(v: number): void {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) {
      throw new RangeError(`writeU16: ${v} does not fit in a uint16`);
    }
    this.bytes.push(v & 0xff, (v >> 8) & 0xff);
  }

  writeU32(v: number): void {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) {
      throw new RangeError(`writeU32: ${v} does not fit in a uint32`);
    }
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  }

  /** Signed two's-complement; unused by the current layouts (coords are >= 0). */
  writeI16(v: number): void {
    if (!Number.isInteger(v) || v < -0x8000 || v > 0x7fff) {
      throw new RangeError(`writeI16: ${v} does not fit in an int16`);
    }
    this.bytes.push(v & 0xff, (v >> 8) & 0xff);
  }

  writeFloat64(v: number): void {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, v, true);
    for (let i = 0; i < 8; i++) this.bytes.push(view.getUint8(i));
  }

  /** UTF-8 string with a 1-byte length prefix (max 255 encoded bytes). */
  writeString(s: string): void {
    const bytes = encoder.encode(s);
    if (bytes.length > 0xff) {
      throw new RangeError(`writeString: '${s.slice(0, 32)}…' is ${bytes.length} bytes (max 255)`);
    }
    this.writeU8(bytes.length);
    for (let i = 0; i < bytes.length; i++) this.bytes.push(bytes[i]);
  }

  /** UTF-8 string with a 2-byte length prefix, for JSON component blobs. */
  writeLongString(s: string): void {
    const bytes = encoder.encode(s);
    if (bytes.length > 0xffff) {
      throw new RangeError(
        `writeLongString: ${bytes.length} bytes exceeds the uint16 length field`,
      );
    }
    this.writeU16(bytes.length);
    for (let i = 0; i < bytes.length; i++) this.bytes.push(bytes[i]);
  }

  toBuffer(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

/** Reads the byte stream written by BinaryEncoder. Out-of-bounds reads throw. */
export class BinaryDecoder {
  private view: DataView;
  private offset: number;

  constructor(buf: Uint8Array, offset = 0) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.offset = offset;
  }

  /** Bytes not yet consumed; the message types above end exactly at the end. */
  remaining(): number {
    return this.view.byteLength - this.offset;
  }

  readU8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  readU16(): number {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  readU32(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  readI16(): number {
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }

  readFloat64(): number {
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }

  /** UTF-8 string with a 1-byte length prefix. */
  readString(): string {
    const len = this.readU8();
    return this.readRaw(len);
  }

  /** UTF-8 string with a 2-byte length prefix. */
  readLongString(): string {
    const len = this.readU16();
    return this.readRaw(len);
  }

  private readRaw(len: number): string {
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, len);
    this.offset += len;
    return decoder.decode(bytes);
  }
}

// ── shared pieces ──────────────────────────────────────────────────────────

function encodeEntity(e: BinaryEncoder, entity: EntityState): void {
  e.writeU32(entity.id);
  e.writeString(entity.kind);
  e.writeU16(entity.x);
  e.writeU16(entity.y);
  const keys = Object.keys(entity.components);
  e.writeU8(keys.length);
  for (const key of keys) {
    e.writeString(key);
    // Components are JSON data; `undefined` values would stringify to
    // nothing, so guard them with 'null' (never produced by the world).
    const json = JSON.stringify(entity.components[key]);
    e.writeLongString(json === undefined ? 'null' : json);
  }
}

function decodeEntity(d: BinaryDecoder): EntityState {
  const id = d.readU32();
  const kind = d.readString();
  const x = d.readU16();
  const y = d.readU16();
  const componentCount = d.readU8();
  const components: Record<string, unknown> = {};
  for (let i = 0; i < componentCount; i++) {
    const key = d.readString();
    components[key] = JSON.parse(d.readLongString());
  }
  return { id, kind, x, y, components };
}

function encodeTile(e: BinaryEncoder, tile: TileState): void {
  e.writeU16(tile.x);
  e.writeU16(tile.y);
  const byte = TILE_BYTE_BY_KIND[tile.kind];
  if (byte === undefined) {
    // Unknown kind: escape byte + string, so the round-trip stays lossless
    // even for kinds added after this table.
    e.writeU8(TILE_KIND_ESCAPE);
    e.writeString(tile.kind);
  } else {
    e.writeU8(byte);
  }
}

function decodeTile(d: BinaryDecoder): TileState {
  const x = d.readU16();
  const y = d.readU16();
  const byte = d.readU8();
  const kind = byte === TILE_KIND_ESCAPE ? d.readString() : (TILE_KIND_BY_BYTE[byte] ?? 'grass');
  return { x, y, kind };
}

/** Absent or empty disabledFeatures encode as count 0 and decode as undefined. */
function encodeDisabledFeatures(e: BinaryEncoder, names: string[] | undefined): void {
  const list = names ?? [];
  e.writeU8(list.length);
  for (const name of list) e.writeString(name);
}

function decodeDisabledFeatures(d: BinaryDecoder): string[] | undefined {
  const count = d.readU8();
  if (count === 0) return undefined;
  const names: string[] = [];
  for (let i = 0; i < count; i++) names.push(d.readString());
  return names;
}

// ── FullSnapshot (0x01) ─────────────────────────────────────────────────────

export function encodeFullSnapshot(s: FullSnapshot): Uint8Array {
  const e = new BinaryEncoder();
  e.writeU8(MSG_FULL);
  e.writeU32(s.tick);
  e.writeU16(s.playerX);
  e.writeU16(s.playerY);
  e.writeU16(s.entities.length);
  for (const entity of s.entities) encodeEntity(e, entity);
  e.writeU16(s.tiles.length);
  for (const tile of s.tiles) encodeTile(e, tile);
  encodeDisabledFeatures(e, s.disabledFeatures);
  return e.toBuffer();
}

export function decodeFullSnapshot(buf: Uint8Array, offset: number): FullSnapshot {
  const d = new BinaryDecoder(buf, offset);
  const tick = d.readU32();
  const playerX = d.readU16();
  const playerY = d.readU16();
  const entityCount = d.readU16();
  const entities: EntityState[] = [];
  for (let i = 0; i < entityCount; i++) entities.push(decodeEntity(d));
  const tileCount = d.readU16();
  const tiles: TileState[] = [];
  for (let i = 0; i < tileCount; i++) tiles.push(decodeTile(d));
  const disabledFeatures = decodeDisabledFeatures(d);
  const full: FullSnapshot = { t: 'full', tick, entities, tiles, playerX, playerY };
  if (disabledFeatures !== undefined) full.disabledFeatures = disabledFeatures;
  return full;
}

// ── DeltaSnapshot (0x02) ────────────────────────────────────────────────────

export function encodeDeltaSnapshot(s: DeltaSnapshot): Uint8Array {
  const e = new BinaryEncoder();
  e.writeU8(MSG_DELTA);
  e.writeU32(s.tick);
  e.writeU16(s.playerX);
  e.writeU16(s.playerY);
  e.writeU16(s.entities.length);
  for (const entity of s.entities) encodeEntity(e, entity);
  e.writeU16(s.removedEntities.length);
  for (const id of s.removedEntities) e.writeU32(id);
  e.writeU16(s.tiles.length);
  for (const tile of s.tiles) encodeTile(e, tile);
  e.writeU16(s.removedTiles.length);
  for (const tile of s.removedTiles) {
    e.writeU16(tile.x);
    e.writeU16(tile.y);
  }
  encodeDisabledFeatures(e, s.disabledFeatures);
  return e.toBuffer();
}

export function decodeDeltaSnapshot(buf: Uint8Array, offset: number): DeltaSnapshot {
  const d = new BinaryDecoder(buf, offset);
  const tick = d.readU32();
  const playerX = d.readU16();
  const playerY = d.readU16();
  const entityCount = d.readU16();
  const entities: EntityState[] = [];
  for (let i = 0; i < entityCount; i++) entities.push(decodeEntity(d));
  const removedEntityCount = d.readU16();
  const removedEntities: number[] = [];
  for (let i = 0; i < removedEntityCount; i++) removedEntities.push(d.readU32());
  const tileCount = d.readU16();
  const tiles: TileState[] = [];
  for (let i = 0; i < tileCount; i++) tiles.push(decodeTile(d));
  const removedTileCount = d.readU16();
  const removedTiles: { x: number; y: number }[] = [];
  for (let i = 0; i < removedTileCount; i++) {
    removedTiles.push({ x: d.readU16(), y: d.readU16() });
  }
  const disabledFeatures = decodeDisabledFeatures(d);
  const delta: DeltaSnapshot = {
    t: 'delta',
    tick,
    entities,
    removedEntities,
    tiles,
    removedTiles,
    playerX,
    playerY,
  };
  if (disabledFeatures !== undefined) delta.disabledFeatures = disabledFeatures;
  return delta;
}

// ── Welcome (0x03) ──────────────────────────────────────────────────────────

export function encodeWelcome(w: WelcomeMessage): Uint8Array {
  const e = new BinaryEncoder();
  e.writeU8(MSG_WELCOME);
  e.writeU32(w.entityId);
  e.writeString(w.color);
  // View limits: the server is authoritative about how much world it sends.
  e.writeU16(w.viewRadiusX ?? VIEW_RADIUS_X);
  e.writeU16(w.viewRadiusY ?? VIEW_RADIUS_Y);
  e.writeU16(w.tileSize ?? TILE_SIZE);
  return e.toBuffer();
}

export function decodeWelcome(buf: Uint8Array, offset: number): WelcomeMessage {
  const d = new BinaryDecoder(buf, offset);
  return {
    t: 'welcome',
    entityId: d.readU32(),
    color: d.readString(),
    viewRadiusX: d.readU16(),
    viewRadiusY: d.readU16(),
    tileSize: d.readU16(),
  };
}

// ── Pong (0x04) ─────────────────────────────────────────────────────────────

export function encodePong(p: Pong): Uint8Array {
  const e = new BinaryEncoder();
  e.writeU8(MSG_PONG);
  e.writeFloat64(p.ts);
  return e.toBuffer();
}

export function decodePong(buf: Uint8Array, offset: number): Pong {
  const d = new BinaryDecoder(buf, offset);
  return { t: 'pong', ts: d.readFloat64() };
}

// ── RecipesMessage (0x05) ───────────────────────────────────────────────────

function encodeRecipeInput(e: BinaryEncoder, input: RecipeInput): void {
  if (input.tag !== undefined) {
    e.writeU8(1);
    e.writeString(input.tag);
  } else if (input.id !== undefined) {
    e.writeU8(2);
    e.writeString(input.id);
  } else {
    e.writeU8(0);
    e.writeString('');
  }
  e.writeU16(input.count);
}

function decodeRecipeInput(d: BinaryDecoder): RecipeInput {
  const which = d.readU8();
  const value = d.readString();
  const count = d.readU16();
  if (which === 1) return { tag: value, count };
  if (which === 2) return { id: value, count };
  return { count };
}

function encodeRecipe(e: BinaryEncoder, recipe: RecipeDef): void {
  e.writeString(recipe.id);
  e.writeString(recipe.station);
  e.writeU16(recipe.ticks);
  e.writeU16(recipe.inputs.length);
  for (const input of recipe.inputs) encodeRecipeInput(e, input);
  e.writeU16(recipe.outputs.length);
  for (const output of recipe.outputs) {
    e.writeString(output.id);
    e.writeU16(output.count);
  }
}

function decodeRecipe(d: BinaryDecoder): RecipeDef {
  const id = d.readString();
  const station = d.readString();
  const ticks = d.readU16();
  const inputCount = d.readU16();
  const inputs: RecipeInput[] = [];
  for (let i = 0; i < inputCount; i++) inputs.push(decodeRecipeInput(d));
  const outputCount = d.readU16();
  const outputs: { id: string; count: number }[] = [];
  for (let i = 0; i < outputCount; i++) {
    outputs.push({ id: d.readString(), count: d.readU16() });
  }
  return { id, station, inputs, outputs, ticks };
}

export function encodeRecipes(m: RecipesMessage): Uint8Array {
  const e = new BinaryEncoder();
  e.writeU8(MSG_RECIPES);
  e.writeU16(m.recipes.length);
  for (const recipe of m.recipes) encodeRecipe(e, recipe);
  return e.toBuffer();
}

export function decodeRecipes(buf: Uint8Array, offset: number): RecipesMessage {
  const d = new BinaryDecoder(buf, offset);
  const recipeCount = d.readU16();
  const recipes: RecipeDef[] = [];
  for (let i = 0; i < recipeCount; i++) recipes.push(decodeRecipe(d));
  return { t: 'recipes', recipes };
}

// ── Top-level dispatch ──────────────────────────────────────────────────────

/** One frame per message: [type byte][payload], ready for socket.send. */
export function encodeServerMessage(msg: ServerMessage): Uint8Array {
  switch (msg.t) {
    case 'full':
      return encodeFullSnapshot(msg);
    case 'delta':
      return encodeDeltaSnapshot(msg);
    case 'welcome':
      return encodeWelcome(msg);
    case 'pong':
      return encodePong(msg);
    case 'recipes':
      return encodeRecipes(msg);
    default:
      // Exhaustive: every ServerMessage discriminant is handled above.
      throw new Error(
        `encodeServerMessage: unknown message type '${String((msg as { t?: unknown }).t)}'`,
      );
  }
}

/** Parse a received frame (type byte + payload) back into a ServerMessage. */
export function decodeServerMessage(buf: Uint8Array): ServerMessage {
  if (buf.length < 1) throw new Error('decodeServerMessage: empty frame');
  const type = buf[0];
  switch (type) {
    case MSG_FULL:
      return decodeFullSnapshot(buf, 1);
    case MSG_DELTA:
      return decodeDeltaSnapshot(buf, 1);
    case MSG_WELCOME:
      return decodeWelcome(buf, 1);
    case MSG_PONG:
      return decodePong(buf, 1);
    case MSG_RECIPES:
      return decodeRecipes(buf, 1);
    default:
      throw new Error(`decodeServerMessage: unknown message type 0x${type.toString(16)}`);
  }
}
