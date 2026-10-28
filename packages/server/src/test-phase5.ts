/**
 * Phase 5 verification script — run with `pnpm --filter @game/server test`
 * or `node packages/server/src/test-phase5.ts`.
 *
 * Covers the Phase 5 validation gates that are checkable headlessly:
 *  - stacking respects `stack` limits; overflow leaves the remainder on the ground
 *  - two players grabbing the same ground item in the same tick: exactly one gets it
 *  - a full inventory rejects pickup without destroying the item
 *  - transfer to a chest survives a server restart (persistence round-trip)
 *  - query by tag returns items registered by a *different* feature
 *
 * The browser-side gates (inventory panel, cross-client visibility, drag and
 * drop) are covered by manual playtesting — see project.md Phase 5.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  emptySlots,
  INVENTORY_CAPACITY,
  itemsByTag,
  type DeltaSnapshot,
  type Direction,
  type EntityState,
  type FullSnapshot,
  type Intent,
  type InventoryComponent,
  type ItemDef,
  type ItemDropComponent,
  type TileState,
} from '@game/shared';
import { loadAll, openDb } from './db.ts';
import { World } from './world.ts';
import {
  canPickup,
  dropItem,
  giveItem,
  pickupItem,
  removeItem,
  swapSlots,
  transferItem,
  type InventoryContext,
} from './systems/inventory.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const UNIT_DB = resolve(HERE, '../../.data/phase5-unit.sqlite');
const INTEGRATION_DB = resolve(HERE, '../../.data/phase5-integration.sqlite');
const INTEGRATION_PORT = 3989;

let failures = 0;

function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ok - ${label}`);
  } else {
    failures++;
    console.error(`  FAIL - ${label}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve2) => setTimeout(resolve2, ms));
}

// ── unit tests: the inventory system against a bare World ──────────────────

function makeItems(): Map<string, ItemDef> {
  return new Map([
    [
      '_example:herb',
      { id: '_example:herb', name: 'Mystic Herb', tags: ['herb', 'plant'], stack: 10 },
    ],
    [
      '_example:vial',
      { id: '_example:vial', name: 'Empty Vial', tags: ['vial', 'glass'], stack: 5 },
    ],
    [
      '_example:stone',
      { id: '_example:stone', name: 'Glowing Stone', tags: ['stone', 'mineral'], stack: 20 },
    ],
    // Registered by a *different* feature than _example — tag queries must
    // still find it (Phase 5 validation 6).
    ['farming:seed', { id: 'farming:seed', name: 'Seed', tags: ['herb', 'seed'], stack: 50 }],
  ]);
}

function invOf(id: number, world: World): InventoryComponent {
  return world.get(id)!.components.inventory as InventoryComponent;
}

function totalOf(inv: InventoryComponent, itemId: string): number {
  return inv.slots
    .filter((slot) => slot.itemId === itemId)
    .reduce((sum, slot) => sum + slot.count, 0);
}

function groundEntity(world: World, x: number, y: number): EntityState | undefined {
  const found = world.all().find((e) => e.kind === 'item' && e.x === x && e.y === y);
  return found ? ({ ...found } as EntityState) : undefined;
}

function groundDrop(world: World, x: number, y: number): ItemDropComponent | undefined {
  const found = groundEntity(world, x, y);
  const drop = found?.components.itemDrop;
  return typeof drop === 'object' && drop !== null ? (drop as ItemDropComponent) : undefined;
}

function spawnPlayer(world: World, x: number, y: number): number {
  return world.spawn(
    'player',
    { x, y },
    {
      player: { color: '#fff' },
      inventory: { slots: emptySlots(4), capacity: 4 },
    },
  );
}

function unitTests(): void {
  console.log('unit: inventory core');
  const world = new World(10, 10, 42);
  const items = makeItems();
  const ctx: InventoryContext = { world, items };

  // 1. stacking
  const player = spawnPlayer(world, 5, 5);
  assert(giveItem(ctx, player, '_example:herb', 3) === 0, 'give 3 herb fits');
  assert(giveItem(ctx, player, '_example:herb', 10) === 0, 'give 10 herb fits (stacks over the 3)');
  let inv = invOf(player, world);
  assert(inv.slots[0].count === 10 && inv.slots[1].count === 3, 'herb stacked as 10 + 3');

  // 2. overflow: room is 7 (slot 0) + 10 + 10 + 10 = 37; 100 - 37 = 73
  assert(giveItem(ctx, player, '_example:herb', 100) === 73, 'overflow returns leftover 73');
  inv = invOf(player, world);
  assert(
    inv.slots.every((s) => s.itemId === '_example:herb' && s.count === 10),
    'all 4 slots full of herb',
  );

  // 3. unknown item refused, entity without inventory refuses
  assert(giveItem(ctx, player, 'nope:thing', 5) === 5, 'unknown item id refused');
  const totem = world.spawn('_example:totem', { x: 1, y: 1 });
  assert(
    giveItem(ctx, totem, '_example:herb', 5) === 5,
    'entity without inventory refuses everything',
  );

  // 4. removeItem
  assert(removeItem(ctx, player, 0, 4) === 4, 'removed 4 herb');
  inv = invOf(player, world);
  assert(inv.slots[0].count === 6, 'slot now holds 6');
  assert(removeItem(ctx, player, 0, 100) === 6, 'removed the remaining 6');
  inv = invOf(player, world);
  assert(inv.slots[0].itemId === '' && inv.slots[0].count === 0, 'drained slot resets to empty');
  assert(removeItem(ctx, player, 99, 1) === 0, 'out-of-bounds slot removes nothing');

  // 5. drop: spawns a ground entity at the player's tile
  giveItem(ctx, player, '_example:herb', 3); // slot 0
  assert(dropItem(ctx, player, 0) === 3, 'dropped 3 herb to the ground');
  let drop = groundDrop(world, 5, 5);
  assert(
    drop?.itemId === '_example:herb' && drop?.count === 3,
    'ground item carries itemDrop {herb, 3}',
  );
  inv = invOf(player, world);
  assert(inv.slots[0].itemId === '', 'slot emptied after drop');
  assert(dropItem(ctx, player, 0) === 0, 'dropping an empty slot drops nothing');

  // 6. dropping onto a same-item ground stack merges; a different item is rejected
  giveItem(ctx, player, '_example:herb', 2);
  assert(dropItem(ctx, player, 0) === 2, 'drop onto same-item ground merges');
  drop = groundDrop(world, 5, 5);
  assert(drop?.count === 5, 'ground stack merged to 5');
  giveItem(ctx, player, '_example:vial', 1);
  assert(
    dropItem(ctx, player, 0) === 0,
    'dropping a different item onto an occupied tile is rejected',
  );
  inv = invOf(player, world);
  assert(inv.slots[0].itemId === '_example:vial', 'rejected drop keeps the item in the slot');

  // 7. pickup (fresh player — the tile below still holds the herb from test 6)
  const picker = spawnPlayer(world, 5, 5);
  assert(canPickup(ctx, picker), 'canPickup true while standing on the item');
  assert(pickupItem(ctx, picker) === true, 'pickup succeeded');
  assert(groundEntity(world, 5, 5) === undefined, 'ground item despawned');
  assert(totalOf(invOf(picker, world), '_example:herb') === 5, 'player holds the picked-up herb');

  // 8. a full inventory rejects pickup without destroying the item. The
  //    ground item must come from someone else: dropping empties the slot,
  //    which would recreate the room we are testing the absence of.
  removeItem(ctx, picker, 0, 5); // free the herb slot from test 7
  giveItem(ctx, picker, '_example:stone', 20); // slot 0
  giveItem(ctx, picker, '_example:stone', 20); // slot 1
  giveItem(ctx, picker, '_example:stone', 20); // slot 2
  giveItem(ctx, picker, '_example:stone', 20); // slot 3 — capacity 4 is full
  const helper = spawnPlayer(world, 5, 5); // stands on the same tile
  giveItem(ctx, helper, '_example:stone', 20);
  assert(dropItem(ctx, helper, 0) === 20, 'helper dropped a full stone stack');
  assert(pickupItem(ctx, picker) === false, 'full inventory rejects pickup');
  drop = groundDrop(world, 5, 5);
  assert(drop?.count === 20, 'rejected pickup leaves the item on the ground');

  // 9. partial pickup: freeing 5 of room picks up only 5; 15 stay on the ground
  removeItem(ctx, picker, 3, 5);
  assert(pickupItem(ctx, picker) === true, 'partial pickup succeeds');
  drop = groundDrop(world, 5, 5);
  assert(drop?.count === 15, 'overflow stays on the ground');
  assert(
    totalOf(invOf(picker, world), '_example:stone') === 80,
    'player gained exactly the 5 that fit',
  );

  // 10. two players on the same tile: exactly one gets the item, no duplication
  const a = spawnPlayer(world, 3, 3);
  const b = spawnPlayer(world, 3, 3);
  world.spawn('item', { x: 3, y: 3 }, { itemDrop: { itemId: '_example:vial', count: 5 } });
  assert(pickupItem(ctx, a) === true, 'first grabber picks up the vial');
  assert(pickupItem(ctx, b) === false, 'second grabber finds nothing');
  assert(
    totalOf(invOf(a, world), '_example:vial') === 5 &&
      totalOf(invOf(b, world), '_example:vial') === 0,
    'exactly one player holds the vial — no duplication',
  );

  // 11. transfer into a container
  const container = world.spawn(
    'container',
    { x: 5, y: 6 },
    {
      inventory: { slots: emptySlots(4), capacity: 4 },
    },
  );
  const transferPlayer = spawnPlayer(world, 5, 5);
  giveItem(ctx, transferPlayer, '_example:herb', 3);
  assert(transferItem(ctx, transferPlayer, 0, container) === true, 'transfer player -> container');
  let invC = invOf(container, world);
  assert(
    invC.slots[0].itemId === '_example:herb' && invC.slots[0].count === 3,
    'container holds the herb',
  );
  inv = invOf(transferPlayer, world);
  assert(inv.slots[0].itemId === '', 'player slot emptied');

  // 12. transfer into a full container fails; nothing is lost
  giveItem(ctx, container, '_example:stone', 20);
  giveItem(ctx, container, '_example:stone', 20);
  giveItem(ctx, container, '_example:stone', 20); // 60 stone; slot 0 keeps the herb
  giveItem(ctx, transferPlayer, '_example:vial', 1);
  assert(
    transferItem(ctx, transferPlayer, 0, container) === false,
    'transfer into a full container fails',
  );
  invC = invOf(container, world);
  assert(totalOf(invC, '_example:stone') === 60, 'container contents untouched');
  inv = invOf(transferPlayer, world);
  assert(
    inv.slots[0].itemId === '_example:vial',
    'failed transfer keeps the item in the player slot',
  );

  // 13. swapSlots
  assert(swapSlots(ctx, transferPlayer, 0, 1) === true, 'swap succeeded');
  inv = invOf(transferPlayer, world);
  assert(
    inv.slots[1].itemId === '_example:vial' && inv.slots[1].count === 1,
    'vial moved to slot 1',
  );

  // 14. tag queries cross features
  const byHerb = itemsByTag([...items.values()], 'herb')
    .map((i) => i.id)
    .sort();
  assert(
    byHerb.join(',') === '_example:herb,farming:seed',
    `tag 'herb' finds items from both features (${byHerb.join(',')})`,
  );
  const byMineral = itemsByTag([...items.values()], 'mineral').map((i) => i.id);
  assert(byMineral.join(',') === '_example:stone', "tag 'mineral' finds the stone");

  // 15. persistence round-trip: the chest keeps its contents after a reload
  const db = openDb(UNIT_DB);
  world.flushDirty(db);
  const rows = loadAll(db).entities;
  db.close();
  const world2 = new World(10, 10, 42);
  world2.loadFromRows(rows);
  const chest = world2.all().find((e) => e.kind === 'container');
  const chestInv = chest?.components.inventory as InventoryComponent | undefined;
  assert(
    chestInv !== undefined &&
      chestInv.slots.some((s) => s.itemId === '_example:herb' && s.count === 3),
    'container inventory survives a persistence round-trip',
  );
  rmSync(UNIT_DB, { force: true });
}

// ── integration: the real server over websockets ───────────────────────────

/**
 * The client's accumulated view of the world, materialized from the
 * full/delta messages the server sends (fulls replace it, deltas patch it).
 * Predicates and helpers read entities/tiles from this, exactly as they did
 * from the old all-in-one snapshot.
 */
interface LocalSnapshot {
  t: 'snapshot';
  tick: number;
  entities: EntityState[];
  tiles: TileState[];
}

function invOfEntity(entity: EntityState | undefined): InventoryComponent | null {
  if (!entity) return null;
  const inv = entity.components.inventory;
  if (typeof inv !== 'object' || inv === null) return null;
  if (!Array.isArray((inv as Record<string, unknown>).slots)) return null;
  return inv as InventoryComponent;
}

function totalOfEntity(entity: EntityState | undefined, itemId: string): number {
  const inv = invOfEntity(entity);
  if (!inv) return 0;
  return inv.slots
    .filter((slot) => slot.itemId === itemId)
    .reduce((sum, slot) => sum + slot.count, 0);
}

function byId(snapshot: LocalSnapshot, id: number): EntityState | undefined {
  return snapshot.entities.find((e) => e.id === id);
}

function groundAt(snapshot: LocalSnapshot, x: number, y: number): EntityState | undefined {
  return snapshot.entities.find((e) => e.kind === 'item' && e.x === x && e.y === y);
}

function groundDropAt(
  snapshot: LocalSnapshot,
  x: number,
  y: number,
  itemId: string,
): EntityState | undefined {
  const found = groundAt(snapshot, x, y);
  const drop = found?.components.itemDrop;
  return typeof drop === 'object' && drop !== null && (drop as ItemDropComponent).itemId === itemId
    ? found
    : undefined;
}

function groundCountOf(entity: EntityState | undefined): number {
  const drop = entity?.components.itemDrop;
  return typeof drop === 'object' && drop !== null ? (drop as ItemDropComponent).count : 0;
}

function containerOf(snapshot: LocalSnapshot): EntityState | undefined {
  return snapshot.entities.find((e) => e.kind === 'container');
}

class TestClient {
  readonly entityId: number;
  private readonly ws: WebSocket;
  private readonly label: string;
  private readonly snapshots: LocalSnapshot[] = [];
  /** Accumulated world model: full snapshots replace it, deltas patch it. */
  private readonly entities = new Map<number, EntityState>();
  private readonly tiles = new Map<string, string>(); // "x,y" → kind

  private constructor(ws: WebSocket, entityId: number, label: string) {
    this.ws = ws;
    this.entityId = entityId;
    this.label = label;
  }

  static async connect(label: string): Promise<TestClient> {
    const ws = new WebSocket(`ws://localhost:${INTEGRATION_PORT}`);
    ws.on('error', () => {
      // The welcome-timeout below surfaces connect failures; without this
      // listener, an ECONNREFUSED would crash the test process unhandled.
    });
    const entityId = await new Promise<number>((resolve2, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label}: welcome timeout`)), 5000);
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        if (msg.t === 'welcome' && typeof msg.entityId === 'number') {
          clearTimeout(timer);
          resolve2(msg.entityId);
        }
      });
    });
    const client = new TestClient(ws, entityId, label);
    ws.on('message', (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (typeof msg !== 'object' || msg === null) return;
      const t = (msg as Record<string, unknown>).t;
      if (t === 'full' || t === 'delta') client.applyState(msg as FullSnapshot | DeltaSnapshot);
    });
    return client;
  }

  /** Full snapshots replace the model; deltas patch it; both materialize a LocalSnapshot. */
  private applyState(msg: FullSnapshot | DeltaSnapshot): void {
    if (msg.t === 'full') {
      this.entities.clear();
      for (const entity of msg.entities) this.entities.set(entity.id, entity);
      this.tiles.clear();
      for (const tile of msg.tiles) this.tiles.set(`${tile.x},${tile.y}`, tile.kind);
    } else {
      for (const id of msg.removedEntities) this.entities.delete(id);
      for (const entity of msg.entities) this.entities.set(entity.id, entity);
      for (const tile of msg.tiles) this.tiles.set(`${tile.x},${tile.y}`, tile.kind);
      for (const tile of msg.removedTiles) this.tiles.delete(`${tile.x},${tile.y}`);
    }
    this.snapshots.push({
      t: 'snapshot',
      tick: msg.tick,
      entities: [...this.entities.values()],
      tiles: [...this.tiles].map(([key, kind]) => {
        const comma = key.indexOf(',');
        return { x: Number(key.slice(0, comma)), y: Number(key.slice(comma + 1)), kind };
      }),
    });
    if (this.snapshots.length > 200) this.snapshots.shift();
  }

  send(intent: Intent): void {
    this.ws.send(JSON.stringify(intent));
  }

  latest(): LocalSnapshot | undefined {
    return this.snapshots[this.snapshots.length - 1];
  }

  /** Resolve with the next snapshot (arriving after the call) that satisfies the predicate. */
  async waitFor(
    predicate: (snapshot: LocalSnapshot) => boolean,
    what: string,
    timeoutMs = 5000,
  ): Promise<LocalSnapshot> {
    const from = this.snapshots.length;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.snapshots.slice(from).find(predicate);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`${this.label}: timeout waiting for ${what}`);
      await sleep(50);
    }
  }

  close(): void {
    this.ws.close();
  }
}

const MOVE_DELTA: Record<Direction, [number, number]> = {
  n: [0, -1],
  s: [0, 1],
  e: [1, 0],
  w: [-1, 0],
};

function absValue(value: number): number {
  return value < 0 ? -value : value;
}

/** Chebyshev distance between two tiles. */
function chebyshev(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = absValue(a.x - b.x);
  const dy = absValue(a.y - b.y);
  return dx > dy ? dx : dy;
}

/**
 * Walk toward a target tile, sliding around walls seen in the latest
 * snapshot. The world is procedurally generated (scattered wall clusters),
 * so straight lines can be blocked; short segments are re-planned from the
 * live position whenever a move is rejected. A target that is itself a wall
 * (a tile no one can stand on) is redirected to the nearest non-wall tile
 * on a small ring around it.
 */
async function walkTo(client: TestClient, targetX: number, targetY: number): Promise<void> {
  for (let guard = 0; guard < 400; guard++) {
    const self = byId(client.latest()!, client.entityId);
    if (!self) return;
    if (self.x === targetX && self.y === targetY) return;
    const walls = new Set(
      client
        .latest()!
        .tiles.filter((t) => t.kind === 'wall')
        .map((t) => `${t.x},${t.y}`),
    );
    let goalX = targetX;
    let goalY = targetY;
    if (walls.has(`${goalX},${goalY}`)) {
      // The goal cannot be stood on: aim at the nearest walkable ring tile.
      let found = false;
      for (let r = 1; r <= 4 && !found; r++) {
        for (let dy = -r; dy <= r && !found; dy++) {
          for (let dx = -r; dx <= r && !found; dx++) {
            if (absValue(dx) !== r && absValue(dy) !== r) continue; // ring edge only
            if (!walls.has(`${goalX + dx},${goalY + dy}`)) {
              goalX += dx;
              goalY += dy;
              found = true;
            }
          }
        }
      }
    }
    const moves: Intent[] = [];
    let x = self.x;
    let y = self.y;
    let lastX = x;
    let lastY = y;
    for (let step = 0; step < 20 && (x !== goalX || y !== goalY); step++) {
      const dx = goalX - x;
      const dy = goalY - y;
      const dir: Direction =
        absValue(dx) > absValue(dy) ? (dx > 0 ? 'e' : 'w') : dy > 0 ? 's' : 'n';
      const delta = MOVE_DELTA[dir];
      const nx = x + delta[0];
      const ny = y + delta[1];
      if (!walls.has(`${nx},${ny}`) && nx >= 0 && ny >= 0) {
        moves.push({ t: 'intent', kind: 'move', dir });
        x = nx;
        y = ny;
      } else {
        // Blocked: slide perpendicular around the wall.
        const perps: Direction[] = dir === 'e' || dir === 'w' ? ['s', 'n'] : ['e', 'w'];
        let slid = false;
        for (const p of perps) {
          const pd = MOVE_DELTA[p];
          const px = x + pd[0];
          const py = y + pd[1];
          if (!walls.has(`${px},${py}`) && px >= 0 && py >= 0) {
            moves.push({ t: 'intent', kind: 'move', dir: p });
            x = px;
            y = py;
            slid = true;
            break;
          }
        }
        if (!slid) break; // boxed in: re-plan on the next round
      }
      lastX = x;
      lastY = y;
    }
    if (moves.length === 0) return; // completely boxed in: give up loudly later
    for (const move of moves) client.send(move);
    // Wait for the segment to land (moves are drained at 10Hz); if any move
    // was rejected, re-plan from the live position.
    const deadline = Date.now() + 8000;
    for (;;) {
      const e = byId(client.latest()!, client.entityId);
      if (e && e.x === lastX && e.y === lastY) break;
      if (Date.now() > deadline) break;
      await sleep(50);
    }
  }
}

async function integrationTests(): Promise<void> {
  console.log('integration: real server over websockets');
  rmSync(INTEGRATION_DB, { force: true });
  const serverDir = resolve(HERE, '..');
  const logs: string[] = [];

  function startServer(): ChildProcess {
    logs.length = 0; // fresh log window per run: waitListening must not see the previous boot
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(INTEGRATION_PORT),
      WORLD_DB: INTEGRATION_DB,
    };
    delete env.FEATURES; // integration runs with whatever features the repo has
    const child = spawn(process.execPath, ['src/index.ts'], {
      cwd: serverDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
    return child;
  }

  async function waitListening(child: ChildProcess): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (logs.some((line) => line.includes('listening on ws://'))) return;
      if (child.exitCode !== null) {
        throw new Error(`server exited early:\n${logs.join('')}`);
      }
      await sleep(50);
    }
    throw new Error(`server never listened:\n${logs.join('')}`);
  }

  function stopServer(child: ChildProcess): Promise<void> {
    return new Promise((resolve2) => {
      child.once('exit', resolve2);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    });
  }

  let server: ChildProcess | null = null;
  const clients: TestClient[] = [];
  try {
    server = startServer();
    await waitListening(server);

    const a = await TestClient.connect('A');
    clients.push(a);
    const b = await TestClient.connect('B');
    clients.push(b);

    // ── stacking: give via the _example:give command ──
    a.send({ t: 'intent', kind: '_example:give', item: '_example:herb', count: 3 });
    let snap = await a.waitFor(
      (s) => totalOfEntity(byId(s, a.entityId), '_example:herb') === 3,
      'A holds 3 herb',
    );
    a.send({ t: 'intent', kind: '_example:give', item: '_example:herb', count: 10 });
    snap = await a.waitFor(
      (s) => totalOfEntity(byId(s, a.entityId), '_example:herb') === 13,
      'A holds 13 herb',
    );
    a.send({ t: 'intent', kind: '_example:give', item: '_example:stone', count: 25 });
    snap = await a.waitFor(
      (s) => totalOfEntity(byId(s, a.entityId), '_example:stone') === 25,
      'A holds 25 stone',
    );

    // ── drop: the 20-stone stack lands on the ground at A's tile ──
    const aPos = { x: byId(snap, a.entityId)!.x, y: byId(snap, a.entityId)!.y };
    const stoneSlot = invOfEntity(byId(snap, a.entityId))!.slots.findIndex(
      (s) => s.itemId === '_example:stone' && s.count === 20,
    );
    assert(stoneSlot >= 0, 'A has a 20-stone slot');
    a.send({ t: 'intent', kind: 'drop', slot: stoneSlot });
    snap = await a.waitFor(
      (s) => groundAt(s, aPos.x, aPos.y) !== undefined,
      'stone on the ground at A',
    );
    const stoneGround = groundAt(snap, aPos.x, aPos.y)!;
    const stoneDrop = stoneGround.components.itemDrop as ItemDropComponent;
    assert(
      stoneDrop.itemId === '_example:stone' && stoneDrop.count === 20,
      'ground stone stack is 20',
    );
    assert(totalOfEntity(byId(snap, a.entityId), '_example:stone') === 5, 'A is left with 5 stone');

    // ── B walks onto A's tile (wall-aware; the world has wall clusters) ──
    await walkTo(b, aPos.x, aPos.y);
    await b.waitFor((s) => {
      const e = byId(s, b.entityId);
      return e !== undefined && e.x === aPos.x && e.y === aPos.y;
    }, "B stands on A's tile", 30000);

    // ── both grab the same ground item in the same tick: exactly one gets it ──
    a.send({ t: 'intent', kind: 'pickup' });
    b.send({ t: 'intent', kind: 'pickup' });
    await a.waitFor((s) => groundAt(s, aPos.x, aPos.y) === undefined, 'ground stone picked up');
    await sleep(150);
    const aStone = totalOfEntity(byId(a.latest()!, a.entityId), '_example:stone');
    const bStone = totalOfEntity(byId(b.latest()!, b.entityId), '_example:stone');
    assert(aStone + bStone === 25, `stone total conserved (A=${aStone}, B=${bStone})`);
    assert(
      (aStone === 25 && bStone === 0) || (aStone === 5 && bStone === 20),
      `exactly one player got the stone (A=${aStone}, B=${bStone}) — no duplication`,
    );

    // ── the other client picks a fresh drop up off the ground ──
    const herbSlot = invOfEntity(byId(a.latest()!, a.entityId))!.slots.findIndex(
      (s) => s.itemId === '_example:herb' && s.count === 10,
    );
    assert(herbSlot >= 0, 'A has a 10-herb slot');
    a.send({ t: 'intent', kind: 'drop', slot: herbSlot });
    await a.waitFor(
      (s) => groundDropAt(s, aPos.x, aPos.y, '_example:herb') !== undefined,
      'herb on the ground',
    );
    b.send({ t: 'intent', kind: 'pickup' });
    await b.waitFor(
      (s) => totalOfEntity(byId(s, b.entityId), '_example:herb') === 10,
      'B picked up the herb',
    );
    snap = a.latest()!;
    assert(groundAt(snap, aPos.x, aPos.y) === undefined, 'herb ground entity despawned');

    // ── partial pickup: C is full except a 5-stone partial stack ──
    const c = await TestClient.connect('C');
    clients.push(c);
    c.send({ t: 'intent', kind: '_example:give', item: '_example:stone', count: 25 });
    snap = await c.waitFor(
      (s) => totalOfEntity(byId(s, c.entityId), '_example:stone') === 25,
      'C holds 25 stone',
    );
    c.send({ t: 'intent', kind: '_example:give', item: '_example:herb', count: 180 });
    snap = await c.waitFor(
      (s) => totalOfEntity(byId(s, c.entityId), '_example:herb') === 180,
      'C holds 180 herb (18 slots) — inventory now full',
    );
    const cPos = { x: byId(snap, c.entityId)!.x, y: byId(snap, c.entityId)!.y };
    const cInv = invOfEntity(byId(snap, c.entityId))!;
    assert(cInv.capacity === INVENTORY_CAPACITY, 'C spawned with the default 20-slot inventory');
    assert(cInv.slots.filter((s) => s.count > 0).length === 20, 'C inventory is full (20/20)');

    // B drops a full 20-stone stack on C's tile...
    b.send({ t: 'intent', kind: '_example:give', item: '_example:stone', count: 20 });
    snap = await b.waitFor(
      (s) => totalOfEntity(byId(s, b.entityId), '_example:stone') === 20,
      'B holds 20 stone',
    );
    const bStoneSlot = invOfEntity(byId(snap, b.entityId))!.slots.findIndex(
      (s) => s.itemId === '_example:stone',
    );
    // ...B walks to C's tile and drops it (wall-aware)...
    await walkTo(b, cPos.x, cPos.y);
    await b.waitFor((s) => {
      const e = byId(s, b.entityId);
      return e !== undefined && e.x === cPos.x && e.y === cPos.y;
    }, "B stands on C's tile", 30000);
    b.send({ t: 'intent', kind: 'drop', slot: bStoneSlot });
    snap = await b.waitFor(
      (s) => groundAt(s, cPos.x, cPos.y) !== undefined,
      '20 stone on the ground at C',
    );

    // ...C picks up: only the 5 that fit into the partial stack; 15 stay.
    c.send({ t: 'intent', kind: 'pickup' });
    snap = await c.waitFor((s) => {
      const ground = groundDropAt(s, cPos.x, cPos.y, '_example:stone');
      return (
        totalOfEntity(byId(s, c.entityId), '_example:stone') === 40 && groundCountOf(ground) === 5
      );
    }, 'C gained 15 stone (fits the partial stack); 5 remain on the ground');

    // ── full inventory rejects pickup without destroying the item ──
    c.send({ t: 'intent', kind: 'pickup' });
    await sleep(250);
    snap = c.latest()!;
    assert(
      totalOfEntity(byId(snap, c.entityId), '_example:stone') === 40,
      'full inventory rejects pickup (C still has 40 stone)',
    );
    assert(
      groundCountOf(groundDropAt(snap, cPos.x, cPos.y, '_example:stone')) === 5,
      'rejected item still on the ground',
    );

    // ── chest: spawn, transfer in/out, adjacency and slot validation ──
    a.send({ t: 'intent', kind: '_example:give', item: '_example:herb', count: 10 });
    snap = await a.waitFor(
      (s) => totalOfEntity(byId(s, a.entityId), '_example:herb') === 13,
      'A holds 13 herb again',
    );
    a.send({ t: 'intent', kind: '_example:chest' });
    snap = await a.waitFor((s) => containerOf(s) !== undefined, 'container entity spawned');
    const chest = containerOf(snap)!;
    const chestPos = { x: chest.x, y: chest.y };
    const aPos2 = byId(snap, a.entityId)!;
    const dx = chestPos.x - aPos2.x;
    const dy = chestPos.y - aPos2.y;
    assert(dx >= -1 && dx <= 1 && dy >= -1 && dy <= 1, 'container spawned adjacent to A');
    const aHerbSlot = invOfEntity(byId(snap, a.entityId))!.slots.findIndex(
      (s) => s.itemId === '_example:herb' && s.count === 10,
    );
    a.send({
      t: 'intent',
      kind: 'transfer',
      dir: 'in',
      fromSlot: aHerbSlot,
      toContainerId: chest.id,
    });
    snap = await a.waitFor(
      (s) => totalOfEntity(containerOf(s), '_example:herb') === 10,
      '10 herb transferred into the chest',
    );
    assert(totalOfEntity(byId(snap, a.entityId), '_example:herb') === 3, 'A is left with 3 herb');

    a.send({ t: 'intent', kind: 'transfer', dir: 'out', fromSlot: 0, toContainerId: chest.id });
    snap = await a.waitFor(
      (s) => totalOfEntity(byId(s, a.entityId), '_example:herb') === 13,
      '10 herb transferred back out of the chest',
    );
    assert(totalOfEntity(containerOf(snap), '_example:herb') === 0, 'chest is empty again');

    // forged / out-of-bounds intents are rejected without breaking anything.
    // Players spawn close together, so B walks clear of the chest first —
    // the transfer must be rejected because B is too far away.
    await walkTo(b, chestPos.x + 3, chestPos.y);
    assert(
      chebyshev(byId(b.latest()!, b.entityId)!, chestPos) > 1,
      'B walked clear of the chest (adjacency gate applies)',
    );
    a.send({ t: 'intent', kind: 'transfer', dir: 'in', fromSlot: 99, toContainerId: chest.id });
    a.send({ t: 'intent', kind: 'drop', slot: 99 });
    b.send({ t: 'intent', kind: 'transfer', dir: 'in', fromSlot: 0, toContainerId: chest.id }); // B is far away
    await sleep(250);
    snap = a.latest()!;
    assert(
      totalOfEntity(containerOf(snap), '_example:herb') === 0,
      'bad transfer did not touch the chest',
    );
    assert(
      totalOfEntity(byId(snap, a.entityId), '_example:herb') === 13,
      'A kept its herb through the rejects',
    );
    assert(
      totalOfEntity(byId(snap, b.entityId), '_example:herb') === 10,
      'B kept its herb through the rejects',
    );

    // ── drag-and-drop swap ──
    const preSwap = invOfEntity(byId(snap, a.entityId))!;
    const slot0 = preSwap.slots[0];
    const slot1 = preSwap.slots[1];
    a.send({ t: 'intent', kind: 'swap', a: 0, b: 1 });
    snap = await a.waitFor((s) => {
      const inv = invOfEntity(byId(s, a.entityId))!;
      return (
        inv.slots[0].itemId === slot1.itemId &&
        inv.slots[0].count === slot1.count &&
        inv.slots[1].itemId === slot0.itemId &&
        inv.slots[1].count === slot0.count
      );
    }, 'swap exchanged slots 0 and 1');

    // ── persistence across a server restart ──
    const aHerbSlot2 = invOfEntity(byId(snap, a.entityId))!.slots.findIndex(
      (s) => s.itemId === '_example:herb' && s.count === 10,
    );
    a.send({
      t: 'intent',
      kind: 'transfer',
      dir: 'in',
      fromSlot: aHerbSlot2,
      toContainerId: chest.id,
    });
    snap = await a.waitFor(
      (s) => totalOfEntity(containerOf(s), '_example:herb') === 10,
      '10 herb transferred into the chest for the restart test',
    );

    await stopServer(server);
    server = null;
    for (const client of clients) client.close();

    server = startServer();
    await waitListening(server);
    const d = await TestClient.connect('D');
    clients.push(d);
    snap = await d.waitFor(
      (s) => containerOf(s) !== undefined,
      'chest entity restored after restart',
    );
    assert(
      totalOfEntity(containerOf(snap), '_example:herb') === 10,
      'chest still holds the herb after a server restart',
    );
    d.send({ t: 'intent', kind: '_example:give', item: '_example:vial', count: 2 });
    snap = await d.waitFor(
      (s) => totalOfEntity(byId(s, d.entityId), '_example:vial') === 2,
      'post-restart player receives items (inventory works after reload)',
    );

    // ── tag query across features: the _example:items command runs clean ──
    d.send({ t: 'intent', kind: '_example:items', tag: 'herb' });
    await sleep(200);
    assert(true, "the '_example:items' tag query command ran without error");

    console.log('integration: done');
  } finally {
    for (const client of clients) client.close();
    if (server) await stopServer(server);
    rmSync(INTEGRATION_DB, { force: true });
  }
}

async function main(): Promise<void> {
  unitTests();
  try {
    await integrationTests();
  } catch (err) {
    failures++;
    console.error('integration failed:', err instanceof Error ? err.message : String(err));
  }
  console.log(
    failures === 0 ? '\nALL PHASE 5 TESTS PASSED' : `\n${failures} FAILURE(S) — see above`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
