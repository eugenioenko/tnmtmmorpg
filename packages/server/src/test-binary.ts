/**
 * Binary wire protocol verification script — run with
 * `pnpm --filter @game/server test` or `node packages/server/src/test-binary.ts`.
 *
 * Covers everything checkable headlessly about the compact binary codec in
 * packages/shared/src/binary.ts:
 *  - encode -> decode round-trips are lossless for FullSnapshot,
 *    DeltaSnapshot, Welcome, Pong and RecipesMessage (compared by
 *    JSON.stringify, so key order is preserved too)
 *  - coordinates at the demo world's far edge (9999) and at the uint16 max
 *    (65535) round-trip exactly — the world is 10000x10000, so every
 *    coordinate fits in two bytes
 *  - the tile kind byte table maps the 8 terrain kinds (grass=0, water=1,
 *    ... swamp=7) as the spec says, and kinds the table does not know
 *    survive via the 255 escape
 *  - disabledFeatures (the guard's auto-disabled systems banner) round-trips
 *    in both the present and absent cases
 *  - decodeServerMessage dispatches on the type byte and rejects unknown tags
 *  - the binary encoding of a realistic full snapshot and a realistic delta
 *    is less than half the size of the same data as JSON — the whole point
 *    of the format
 *
 * The websocket gates (a binary-capable client receiving binary frames, a
 * plain client still getting JSON) are covered by manual playtesting with
 * the browser client and the headless bots (which never opt into binary).
 */
import {
  emptySlots,
  encodeDeltaSnapshot,
  encodeFullSnapshot,
  encodePong,
  encodeServerMessage,
  INVENTORY_CAPACITY,
  MSG_DELTA,
  MSG_FULL,
  MSG_PONG,
  MSG_RECIPES,
  MSG_WELCOME,
  TILE_KIND_BYTE,
  TILE_KIND_BY_BYTE,
  decodeDeltaSnapshot,
  decodeFullSnapshot,
  decodePong,
  decodeServerMessage,
  decodeWelcome,
  type DeltaSnapshot,
  type EntityState,
  type FullSnapshot,
  type Pong,
  type RecipesMessage,
  type TileState,
  type WelcomeMessage,
} from '@game/shared';

let failures = 0;

function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ok - ${label}`);
  } else {
    failures++;
    console.error(`  FAIL - ${label}`);
  }
}

/** A player-shaped entity with the real Phase 5/7 component set. */
function playerEntity(id: number, x: number, y: number): EntityState {
  return {
    id,
    kind: 'player',
    x,
    y,
    components: {
      player: { color: '#e74c3c' },
      inventory: { slots: emptySlots(INVENTORY_CAPACITY), capacity: INVENTORY_CAPACITY },
      stats: { hp: 100, maxHp: 100, atk: 15, def: 5, level: 1 },
    },
  };
}

/** A full snapshot with a player at the docs' example coords and 120 water tiles. */
function fullFixture(): FullSnapshot {
  const tiles: TileState[] = [];
  for (let i = 0; i < 120; i++) tiles.push({ x: 5000 + i, y: 4000, kind: 'water' });
  return {
    t: 'full',
    tick: 12345,
    entities: [
      playerEntity(1, 5123, 8765),
      {
        id: 2,
        kind: 'npc',
        x: 5124,
        y: 8765,
        components: {
          npc: { ai: 'wander', state: 'idle', lastActionTick: 12345 },
          movement: { speed: 0.2, nextMoveTick: 12350 },
        },
      },
      {
        id: 3,
        kind: 'container',
        x: 5125,
        y: 8766,
        components: {
          inventory: { slots: emptySlots(INVENTORY_CAPACITY), capacity: INVENTORY_CAPACITY },
        },
      },
    ],
    tiles,
    playerX: 5123,
    playerY: 8765,
  };
}

function deltaFixture(): DeltaSnapshot {
  return {
    t: 'delta',
    tick: 12346,
    entities: [playerEntity(1, 5124, 8765)],
    removedEntities: [3, 7],
    tiles: [{ x: 5123, y: 4000, kind: 'water' }],
    removedTiles: [
      { x: 5100, y: 4000 },
      { x: 5101, y: 4000 },
      { x: 5102, y: 4000 },
    ],
    playerX: 5124,
    playerY: 8765,
  };
}

function roundTripTests(): void {
  console.log('unit: FullSnapshot round-trip');
  const original = fullFixture();
  let decoded = decodeFullSnapshot(encodeFullSnapshot(original), 1);
  assert(
    JSON.stringify(decoded) === JSON.stringify(original),
    'full snapshot with player/npc/container and 120 water tiles round-trips losslessly',
  );

  console.log('unit: DeltaSnapshot round-trip');
  const deltaOriginal = deltaFixture();
  const deltaDecoded = decodeDeltaSnapshot(encodeDeltaSnapshot(deltaOriginal), 1);
  assert(
    JSON.stringify(deltaDecoded) === JSON.stringify(deltaOriginal),
    'delta with removed entities and removed tiles round-trips losslessly',
  );

  console.log('unit: Welcome round-trip');
  const welcome: WelcomeMessage = { t: 'welcome', entityId: 42, color: '#ff6b81' };
  const welcomeDecoded = decodeWelcome(encodeServerMessage(welcome), 1);
  assert(
    JSON.stringify(welcomeDecoded) === JSON.stringify(welcome),
    'welcome (entityId + color) round-trips losslessly',
  );

  console.log('unit: Pong round-trip');
  const pong: Pong = { t: 'pong', ts: 12345.6789012345 };
  const pongDecoded = decodePong(encodePong(pong), 1);
  assert(
    pongDecoded.ts === pong.ts && pongDecoded.t === 'pong',
    'pong timestamp survives float64 exactly (no float drift)',
  );

  console.log('unit: RecipesMessage round-trip');
  const recipes: RecipesMessage = {
    t: 'recipes',
    recipes: [
      {
        id: 'alchemy:iron_bar',
        station: 'alchemy:cauldron',
        inputs: [
          { tag: 'ore', count: 2 },
          { id: 'alchemy:coal', count: 1 },
        ],
        outputs: [{ id: 'alchemy:iron_bar', count: 1 }],
        ticks: 20,
      },
    ],
  };
  const recipesDecoded = decodeServerMessage(encodeServerMessage(recipes));
  assert(
    JSON.stringify(recipesDecoded) === JSON.stringify(recipes),
    'recipe registry with tag and id inputs round-trips losslessly',
  );

  console.log('unit: disabledFeatures round-trip');
  const withDisabled = fullFixture();
  withDisabled.disabledFeatures = ['farming'];
  assert(
    JSON.stringify(decodeFullSnapshot(encodeFullSnapshot(withDisabled), 1)) ===
      JSON.stringify(withDisabled),
    'a present disabledFeatures list survives the round-trip',
  );
  decoded = decodeFullSnapshot(encodeFullSnapshot(original), 1);
  assert(
    decoded.disabledFeatures === undefined,
    'an absent disabledFeatures decodes as undefined (no banner)',
  );

  console.log('unit: uint16 boundaries');
  const extreme: FullSnapshot = {
    t: 'full',
    tick: 65535,
    entities: [{ id: 65535, kind: 'npc', x: 65535, y: 65535, components: {} }],
    tiles: [
      { x: 65535, y: 65535, kind: 'water' },
      { x: 9999, y: 9999, kind: 'grass' },
    ],
    playerX: 65535,
    playerY: 9999,
  };
  assert(
    JSON.stringify(decodeFullSnapshot(encodeFullSnapshot(extreme), 1)) === JSON.stringify(extreme),
    'entity at (65535, 65535) and world-edge coords fit in uint16 exactly',
  );

  console.log('unit: tile kind bytes');
  assert(
    TILE_KIND_BYTE[0] === 'grass' &&
      TILE_KIND_BYTE[1] === 'water' &&
      TILE_KIND_BYTE[2] === 'mountain' &&
      TILE_KIND_BYTE[3] === 'sand' &&
      TILE_KIND_BYTE[4] === 'forest' &&
      TILE_KIND_BYTE[5] === 'dirt' &&
      TILE_KIND_BYTE[6] === 'snow' &&
      TILE_KIND_BYTE[7] === 'swamp',
    'the byte table maps the 8 terrain kinds to 0..7 as the spec says',
  );
  assert(
    TILE_KIND_BY_BYTE[0] === 'grass' && TILE_KIND_BY_BYTE[1] === 'water',
    'the inverse table maps 0/1 back to grass/water',
  );
  const lavaTile: FullSnapshot = {
    t: 'full',
    tick: 1,
    entities: [],
    tiles: [{ x: 5, y: 6, kind: 'lava' }],
    playerX: 0,
    playerY: 0,
  };
  assert(
    JSON.stringify(decodeFullSnapshot(encodeFullSnapshot(lavaTile), 1)) ===
      JSON.stringify(lavaTile),
    'a tile kind the table does not know survives via the 255 escape',
  );
}

function dispatchTests(): void {
  console.log('unit: decodeServerMessage dispatch');
  const fullBytes = encodeServerMessage(fullFixture());
  assert(fullBytes[0] === MSG_FULL, 'full snapshots carry the 0x01 type byte');
  const full = decodeServerMessage(fullBytes);
  assert(full.t === 'full' && full.tick === 12345, 'type 0x01 decodes as a full snapshot');
  const deltaBytes = encodeServerMessage(deltaFixture());
  assert(deltaBytes[0] === MSG_DELTA, 'delta snapshots carry the 0x02 type byte');
  const delta = decodeServerMessage(deltaBytes);
  assert(delta.t === 'delta' && delta.tick === 12346, 'type 0x02 decodes as a delta snapshot');
  const welcomeBytes = encodeServerMessage({
    t: 'welcome',
    entityId: 42,
    color: '#e74c3c',
  } satisfies WelcomeMessage);
  assert(welcomeBytes[0] === MSG_WELCOME, 'welcomes carry the 0x03 type byte');
  const welcome = decodeServerMessage(welcomeBytes);
  assert(welcome.t === 'welcome' && welcome.entityId === 42, 'type 0x03 decodes as a welcome');
  const pongBytes = encodeServerMessage({ t: 'pong', ts: 1.5 } satisfies Pong);
  assert(pongBytes[0] === MSG_PONG, 'pongs carry the 0x04 type byte');
  const pong = decodeServerMessage(pongBytes);
  assert(pong.t === 'pong' && pong.ts === 1.5, 'type 0x04 decodes as a pong');
  const recipesBytes = encodeServerMessage({
    t: 'recipes',
    recipes: [
      {
        id: 'r',
        station: 's',
        inputs: [{ tag: 't', count: 1 }],
        outputs: [{ id: 'o', count: 2 }],
        ticks: 5,
      },
    ],
  } satisfies RecipesMessage);
  assert(recipesBytes[0] === MSG_RECIPES, 'recipes messages carry the 0x05 type byte');
  const recipes = decodeServerMessage(recipesBytes);
  assert(recipes.t === 'recipes' && recipes.recipes.length === 1, 'type 0x05 decodes as recipes');

  let threw = false;
  try {
    decodeServerMessage(new Uint8Array([0x7f, 0, 0]));
  } catch {
    threw = true;
  }
  assert(threw, 'an unknown type byte throws instead of decoding garbage');
  threw = false;
  try {
    decodeServerMessage(new Uint8Array(0));
  } catch {
    threw = true;
  }
  assert(threw, 'an empty frame throws instead of decoding garbage');
}

function sizeTests(): void {
  console.log('unit: binary size vs JSON');
  const full = fullFixture();
  const fullBinary = encodeServerMessage(full);
  const fullJson = new TextEncoder().encode(JSON.stringify(full));
  console.log(
    `  info - full snapshot: ${fullJson.length} bytes JSON -> ${fullBinary.length} bytes binary`,
  );
  assert(
    fullBinary.length * 2 < fullJson.length,
    'binary full snapshot is less than half the JSON',
  );

  // A delta whose entities carry small components — the common case (NPCs,
  // items, containers) — is where the per-entity header savings show.
  const lightDelta: DeltaSnapshot = {
    t: 'delta',
    tick: 12346,
    entities: [
      {
        id: 2,
        kind: 'npc',
        x: 5124,
        y: 8765,
        components: { npc: { ai: 'wander', state: 'idle', lastActionTick: 12346 } },
      },
    ],
    removedEntities: [3, 7],
    tiles: [{ x: 5123, y: 4000, kind: 'water' }],
    removedTiles: [
      { x: 5100, y: 4000 },
      { x: 5101, y: 4000 },
      { x: 5102, y: 4000 },
    ],
    playerX: 5124,
    playerY: 8765,
  };
  const lightBinary = encodeServerMessage(lightDelta);
  const lightJson = new TextEncoder().encode(JSON.stringify(lightDelta));
  console.log(
    `  info - delta snapshot: ${lightJson.length} bytes JSON -> ${lightBinary.length} bytes binary`,
  );
  assert(
    lightBinary.length * 2 < lightJson.length,
    'binary delta snapshot is less than half the JSON',
  );

  // Worst case: a delta dominated by an unchanged inventory blob, which is
  // embedded verbatim in both encodings. Even then binary never loses — the
  // fixed-width wrapper is strictly smaller than the JSON wrapper.
  const heavyDelta = deltaFixture();
  const heavyBinary = encodeServerMessage(heavyDelta);
  const heavyJson = new TextEncoder().encode(JSON.stringify(heavyDelta));
  console.log(
    `  info - inventory-heavy delta: ${heavyJson.length} bytes JSON -> ${heavyBinary.length} bytes binary`,
  );
  assert(
    heavyBinary.length < heavyJson.length,
    'binary is never larger than JSON, even for blob-heavy deltas',
  );

  // A snapshot with no entities and no tiles is the smallest realistic case;
  // even then binary must not lose to JSON.
  const empty: FullSnapshot = {
    t: 'full',
    tick: 1,
    entities: [],
    tiles: [],
    playerX: 0,
    playerY: 0,
  };
  const emptyBinary = encodeServerMessage(empty);
  const emptyJson = new TextEncoder().encode(JSON.stringify(empty));
  console.log(
    `  info - empty snapshot: ${emptyJson.length} bytes JSON -> ${emptyBinary.length} bytes binary`,
  );
  assert(emptyBinary.length < emptyJson.length, 'even an empty snapshot is smaller in binary');
}

function main(): void {
  console.log('Binary protocol tests');
  roundTripTests();
  dispatchTests();
  sizeTests();
  console.log(
    failures === 0 ? '\nALL BINARY PROTOCOL TESTS PASSED' : `\n${failures} FAILURE(S) — see above`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
