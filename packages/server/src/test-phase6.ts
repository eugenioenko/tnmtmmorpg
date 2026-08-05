/**
 * Phase 6 verification script — run with `pnpm --filter @game/server test`
 * or `node packages/server/src/test-phase6.ts`.
 *
 * Covers the Phase 6 validation gates that are checkable headlessly:
 *  - inputs consumed at craft start, outputs produced on completion
 *  - progress ticks advance and are visible in BOTH clients
 *  - walking away mid-craft does not cancel or duplicate the job
 *  - cancelling refunds exactly the inputs — no dupe, no loss
 *  - server restart mid-craft resumes the job at the correct progress
 *  - interop: a { tag: 'herb' } input consumes an item registered by a
 *    DIFFERENT feature (farming:seed) with no code shared between them
 *  - forged craft intents for recipes whose inputs you lack are rejected
 *    server-side
 *  - two players crafting at the same station simultaneously: per-player
 *    parallel jobs, with a per-player queue for extra crafts
 *
 * The browser-side gates (recipe panel, on-canvas progress bars) are covered
 * by manual playtesting — see project.md Phase 6.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  emptySlots,
  itemsByTag,
  type CraftingComponent,
  type CraftingJob,
  type DeltaSnapshot,
  type Direction,
  type EntityState,
  type FullSnapshot,
  type Intent,
  type InventoryComponent,
  type ItemDef,
  type RecipeDef,
  type TileState,
} from '@game/shared';
import { loadAll, openDb } from './db.ts';
import { World } from './world.ts';
import { giveItem } from './systems/inventory.ts';
import {
  cancelCraft,
  getAvailableRecipes,
  isCrafting,
  startCraft,
  tickCrafting,
  type CraftingContext,
} from './systems/crafting.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const UNIT_DB = resolve(HERE, '../../.data/phase6-unit.sqlite');
const INTEGRATION_DB = resolve(HERE, '../../.data/phase6-integration.sqlite');
const INTEGRATION_PORT = 3990;

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

// ── unit tests: the crafting system against a bare World ───────────────────

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
    [
      '_example:glowing_essence',
      {
        id: '_example:glowing_essence',
        name: 'Glowing Essence',
        tags: ['essence', 'magic'],
        stack: 5,
      },
    ],
    [
      '_example:polished_stone',
      {
        id: '_example:polished_stone',
        name: 'Polished Stone',
        tags: ['stone', 'crafted'],
        stack: 5,
      },
    ],
    // Registered by a DIFFERENT feature than the recipe's — the interop test.
    ['farming:seed', { id: 'farming:seed', name: 'Seed', tags: ['herb', 'seed'], stack: 50 }],
  ]);
}

function makeRecipes(): Map<string, RecipeDef> {
  return new Map([
    [
      '_example:glowing_essence',
      {
        id: '_example:glowing_essence',
        station: '_example:workbench',
        inputs: [
          { tag: 'herb', count: 2 },
          { id: '_example:vial', count: 1 },
        ],
        outputs: [{ id: '_example:glowing_essence', count: 1 }],
        ticks: 30,
      },
    ],
    [
      '_example:polished_stone',
      {
        id: '_example:polished_stone',
        station: '_example:workbench',
        inputs: [{ id: '_example:stone', count: 3 }],
        outputs: [{ id: '_example:polished_stone', count: 1 }],
        ticks: 20,
      },
    ],
  ]);
}

function makeCtx(world: World): CraftingContext {
  return { world, items: makeItems(), recipes: makeRecipes() };
}

function spawnPlayer(world: World, x: number, y: number, capacity = 8): number {
  return world.spawn(
    'player',
    { x, y },
    {
      player: { color: '#fff' },
      inventory: { slots: emptySlots(capacity), capacity },
    },
  );
}

function spawnStation(world: World, x: number, y: number): number {
  return world.spawn('_example:workbench', { x, y });
}

function invOf(id: number, world: World): InventoryComponent {
  return world.get(id)!.components.inventory as InventoryComponent;
}

function totalOf(inv: InventoryComponent, itemId: string): number {
  return inv.slots
    .filter((slot) => slot.itemId === itemId)
    .reduce((sum, slot) => sum + slot.count, 0);
}

function craftingOf(world: World, stationId: number): CraftingComponent | null {
  const crafting = world.get(stationId)?.components.crafting;
  return isCrafting(crafting) ? crafting : null;
}

function groundDropAt(
  world: World,
  x: number,
  y: number,
): { itemId: string; count: number } | null {
  const found = world
    .all()
    .find((e) => e.kind === 'item' && e.x === x && e.y === y && e.components.itemDrop);
  const drop = found?.components.itemDrop as { itemId: string; count: number } | undefined;
  return drop ?? null;
}

function unitTests(): void {
  console.log('unit: crafting core');
  const world = new World(12, 12, 7);
  const ctx = makeCtx(world);

  // 1. getAvailableRecipes matches by station kind
  const station = spawnStation(world, 5, 5);
  const ids = getAvailableRecipes(ctx, station)
    .map((r) => r.id)
    .sort();
  assert(
    ids.join(',') === '_example:glowing_essence,_example:polished_stone',
    'getAvailableRecipes returns the workbench recipes',
  );
  const container = world.spawn('container', { x: 1, y: 1 });
  assert(getAvailableRecipes(ctx, container).length === 0, 'a non-station entity has no recipes');

  // 2. startCraft consumes inputs and creates a job
  const crafter = spawnPlayer(world, 5, 6); // adjacent to the station
  giveItem(ctx, crafter, '_example:herb', 2);
  giveItem(ctx, crafter, '_example:vial', 1);
  let result = startCraft(ctx, crafter, station, '_example:glowing_essence');
  assert(result.ok, 'startCraft succeeds with the right inputs');
  let inv = invOf(crafter, world);
  assert(totalOf(inv, '_example:herb') === 0, 'herb consumed at craft start');
  assert(totalOf(inv, '_example:vial') === 0, 'vial consumed at craft start');
  let crafting = craftingOf(world, station);
  assert(
    crafting?.activeJobs.length === 1 && crafting?.queue.length === 0,
    'exactly one active job on the station',
  );
  const job = crafting!.activeJobs[0] as CraftingJob;
  assert(job.progress === 0 && job.totalTicks === 30, 'job records 0/30 ticks');
  assert(
    job.consumed.some((c) => c.itemId === '_example:herb' && c.count === 2) &&
      job.consumed.some((c) => c.itemId === '_example:vial' && c.count === 1),
    'job records the exact consumed items (for the refund)',
  );

  // 3. missing inputs are rejected atomically — nothing is consumed
  const broke = spawnPlayer(world, 6, 5);
  giveItem(ctx, broke, '_example:herb', 1); // not enough
  giveItem(ctx, broke, '_example:vial', 1);
  result = startCraft(ctx, broke, station, '_example:glowing_essence');
  assert(!result.ok && result.reason === 'missing_inputs', 'missing inputs rejected');
  inv = invOf(broke, world);
  assert(
    totalOf(inv, '_example:herb') === 1 && totalOf(inv, '_example:vial') === 1,
    'rejected craft consumed nothing (atomic)',
  );

  // 4. wrong station / unknown recipe / unknown station are rejected
  result = startCraft(ctx, crafter, container, '_example:glowing_essence');
  assert(!result.ok && result.reason === 'wrong_station', 'recipe on the wrong station rejected');
  result = startCraft(ctx, crafter, station, 'nope:recipe');
  assert(!result.ok && result.reason === 'no_recipe', 'unknown recipe rejected');
  result = startCraft(ctx, crafter, 9999, '_example:glowing_essence');
  assert(!result.ok && result.reason === 'no_station', 'unknown station rejected');

  // 5. crafting from far away is rejected
  const far = spawnPlayer(world, 9, 9);
  giveItem(ctx, far, '_example:herb', 2);
  giveItem(ctx, far, '_example:vial', 1);
  result = startCraft(ctx, far, station, '_example:glowing_essence');
  assert(!result.ok && result.reason === 'too_far', 'crafting from afar rejected');

  // 6. tickCrafting progresses and completes a job
  const polisher = spawnPlayer(world, 5, 4);
  giveItem(ctx, polisher, '_example:stone', 3);
  result = startCraft(ctx, polisher, station, '_example:polished_stone');
  assert(result.ok, 'polished_stone craft starts');
  for (let i = 0; i < 19; i++) tickCrafting(ctx);
  crafting = craftingOf(world, station);
  assert(
    crafting!.activeJobs.some((j) => j.recipeId === '_example:polished_stone' && j.progress === 19),
    'job at 19/20 after 19 ticks',
  );
  tickCrafting(ctx);
  inv = invOf(polisher, world);
  assert(totalOf(inv, '_example:polished_stone') === 1, 'output delivered on completion');
  assert(totalOf(inv, '_example:stone') === 0, 'inputs fully consumed');
  crafting = craftingOf(world, station);
  assert(
    !crafting!.activeJobs.some((j) => j.recipeId === '_example:polished_stone'),
    'finished job removed from the station',
  );

  // 7. THE INTEROP TEST: a tag input consumes an item from another feature.
  //    farming:seed carries the 'herb' tag but was registered by 'farming',
  //    not by '_example' — the recipe never imports farming.
  const alchemist = spawnPlayer(world, 5, 5); // stands ON the station tile: adjacent
  giveItem(ctx, alchemist, 'farming:seed', 2);
  giveItem(ctx, alchemist, '_example:vial', 1);
  result = startCraft(ctx, alchemist, station, '_example:glowing_essence');
  assert(result.ok, "interop craft with another feature's item starts");
  inv = invOf(alchemist, world);
  assert(totalOf(inv, 'farming:seed') === 0, "the other feature's seeds were consumed");
  assert(totalOf(inv, '_example:vial') === 0, 'vial consumed alongside');
  tickCrafting(ctx); // progress 1
  for (let i = 0; i < 30; i++) tickCrafting(ctx);
  inv = invOf(alchemist, world);
  assert(totalOf(inv, '_example:glowing_essence') === 1, 'essence produced from foreign inputs');
  const byHerb = itemsByTag([...ctx.items.values()], 'herb')
    .map((i) => i.id)
    .sort();
  assert(
    byHerb.join(',') === '_example:herb,farming:seed',
    `tag 'herb' spans both features (${byHerb.join(',')})`,
  );

  // 8. per-player parallel jobs + per-player queue
  const a = spawnPlayer(world, 4, 5);
  const b = spawnPlayer(world, 4, 6);
  for (const p of [a, b]) {
    giveItem(ctx, p, '_example:herb', 2);
    giveItem(ctx, p, '_example:vial', 1);
  }
  result = startCraft(ctx, a, station, '_example:glowing_essence');
  assert(result.ok, 'A starts a craft');
  result = startCraft(ctx, b, station, '_example:glowing_essence');
  assert(result.ok, 'B starts a craft at the same station');
  crafting = craftingOf(world, station);
  assert(
    crafting!.activeJobs.length === 2 && crafting!.queue.length === 0,
    'two players: both jobs active in parallel',
  );
  giveItem(ctx, a, '_example:stone', 3);
  result = startCraft(ctx, a, station, '_example:polished_stone');
  assert(result.ok, "A's second craft starts");
  crafting = craftingOf(world, station);
  assert(
    crafting!.activeJobs.length === 2 &&
      crafting!.queue.length === 1 &&
      crafting!.queue[0].recipeId === '_example:polished_stone',
    "A's extra craft queued behind A's active job",
  );
  for (let i = 0; i < 30; i++) tickCrafting(ctx); // A's essence (30t) completes
  inv = invOf(a, world);
  assert(totalOf(inv, '_example:glowing_essence') === 1, 'A got the essence');
  crafting = craftingOf(world, station);
  assert(
    // The promotion happens on the completion tick, so the promoted job
    // sits at progress 0 until the next tick.
    crafting!.activeJobs.some(
      (j) => j.recipeId === '_example:polished_stone' && j.progress === 0,
    ) && crafting!.queue.length === 0,
    "A's queued job promoted to active",
  );
  for (let i = 0; i < 20; i++) tickCrafting(ctx); // 20 more ticks
  inv = invOf(a, world);
  assert(totalOf(inv, '_example:polished_stone') === 1, 'A got the polished stone too');
  inv = invOf(b, world);
  assert(totalOf(inv, '_example:glowing_essence') === 1, 'B got the essence (parallel job)');

  // 9. cancelCraft refunds exactly the inputs — no dupe, no loss
  const canceller = spawnPlayer(world, 5, 6);
  giveItem(ctx, canceller, '_example:herb', 3);
  giveItem(ctx, canceller, '_example:vial', 1);
  result = startCraft(ctx, canceller, station, '_example:glowing_essence');
  assert(result.ok, 'cancel test: craft starts');
  result = cancelCraft(ctx, canceller, station, 0);
  assert(result.ok, 'cancel of own job succeeds');
  inv = invOf(canceller, world);
  assert(
    totalOf(inv, '_example:herb') === 3 && totalOf(inv, '_example:vial') === 1,
    'refund is exact — no dupes, no losses',
  );
  crafting = craftingOf(world, station);
  assert(
    !crafting!.activeJobs.some((j) => j.crafterEntityId === canceller),
    'cancelled job removed',
  );
  result = cancelCraft(ctx, canceller, station, 0);
  assert(!result.ok, 'cancelling the same job again is rejected');
  result = cancelCraft(ctx, canceller, station, 5);
  assert(!result.ok, 'out-of-range jobIndex rejected');
  result = cancelCraft(ctx, a, station, 0);
  assert(!result.ok, "cancelling someone else's job is rejected");

  // 10. cancel of a QUEUED job refunds only that job. The canceller starts
  // this section with the items refunded in test 9 (3 herb, 1 vial), so the
  // expected totals below account for those.
  giveItem(ctx, canceller, '_example:herb', 2); // -> 5 herb
  giveItem(ctx, canceller, '_example:vial', 1); // -> 2 vial
  giveItem(ctx, canceller, '_example:stone', 3);
  result = startCraft(ctx, canceller, station, '_example:glowing_essence');
  assert(result.ok, 'queue test: first craft active'); // consumes 2 herb + 1 vial
  result = startCraft(ctx, canceller, station, '_example:polished_stone');
  assert(result.ok, 'queue test: second craft queued'); // consumes 3 stone
  result = cancelCraft(ctx, canceller, station, 1);
  assert(result.ok, 'cancel of own queued job succeeds');
  inv = invOf(canceller, world);
  assert(
    totalOf(inv, '_example:stone') === 3 &&
      totalOf(inv, '_example:herb') === 3 &&
      totalOf(inv, '_example:vial') === 1,
    'queued job refunded only its own inputs (stone back, active craft untouched)',
  );
  crafting = craftingOf(world, station);
  assert(
    crafting!.activeJobs.some((j) => j.crafterEntityId === canceller) &&
      !crafting!.queue.some((j) => j.crafterEntityId === canceller),
    'active job untouched, queued job gone',
  );
  result = cancelCraft(ctx, canceller, station, 0);
  assert(result.ok, 'active job cancelled after its queued sibling');
  inv = invOf(canceller, world);
  assert(
    totalOf(inv, '_example:herb') === 5 && totalOf(inv, '_example:vial') === 2,
    'active job refunded exactly its own inputs (5 herb, 2 vial restored)',
  );

  // 11. a full inventory still refunds without loss (overflow hits the ground)
  const stuffed = spawnPlayer(world, 6, 6, 2);
  giveItem(ctx, stuffed, '_example:herb', 3);
  giveItem(ctx, stuffed, '_example:vial', 1);
  result = startCraft(ctx, stuffed, station, '_example:glowing_essence');
  assert(result.ok, 'full-inventory test: craft starts');
  giveItem(ctx, stuffed, '_example:herb', 5); // slot 0 now holds 6/10
  giveItem(ctx, stuffed, '_example:vial', 5); // slot 1 full (5/5)
  result = cancelCraft(ctx, stuffed, station, 0);
  assert(result.ok, 'full-inventory cancel succeeds');
  inv = invOf(stuffed, world);
  assert(totalOf(inv, '_example:herb') === 8, 'herb refund fit the inventory');
  const dropped = groundDropAt(world, 6, 6);
  assert(
    dropped !== null && dropped.itemId === '_example:vial' && dropped.count === 1,
    'vial that did not fit was dropped on the ground — nothing lost',
  );
  const totalVial = totalOf(inv, '_example:vial') + (dropped?.count ?? 0);
  assert(totalVial === 6, `vial conserved across the refund (${totalVial}/6)`);

  // 12. a full inventory still completes without loss (output hits the ground)
  const packed = spawnPlayer(world, 5, 6, 1);
  giveItem(ctx, packed, '_example:stone', 20); // the only slot is full
  result = startCraft(ctx, packed, station, '_example:polished_stone');
  assert(result.ok, 'full-inventory craft starts');
  for (let i = 0; i < 21; i++) tickCrafting(ctx);
  inv = invOf(packed, world);
  assert(totalOf(inv, '_example:stone') === 17, '3 stone consumed');
  const output = groundDropAt(world, 5, 6);
  assert(
    output !== null && output.itemId === '_example:polished_stone' && output.count === 1,
    'output that did not fit was dropped on the ground',
  );

  // 13. persistence round-trip: progress survives a reload and resumes
  const keeper = spawnPlayer(world, 5, 6);
  giveItem(ctx, keeper, '_example:herb', 2);
  giveItem(ctx, keeper, '_example:vial', 1);
  result = startCraft(ctx, keeper, station, '_example:glowing_essence');
  assert(result.ok, 'persistence test: craft starts');
  for (let i = 0; i < 15; i++) tickCrafting(ctx);
  crafting = craftingOf(world, station);
  assert(crafting!.activeJobs[0].progress === 15, 'job at 15/30 before the reload');
  const db = openDb(UNIT_DB);
  world.flushDirty(db);
  const rows = loadAll(db).entities;
  db.close();

  const world2 = new World(12, 12, 7);
  world2.loadFromRows(rows);
  const station2 = world2.all().find((e) => e.kind === '_example:workbench')!.id;
  const ctx2 = makeCtx(world2);
  crafting = craftingOf(world2, station2);
  assert(
    crafting !== null && crafting.activeJobs[0].progress === 15,
    'job resumed at 15/30 after the reload',
  );
  for (let i = 0; i < 15; i++) tickCrafting(ctx2);
  const keeper2 = world2.all().find((e) => e.kind === 'player' && e.components.player)!.id;
  inv = invOf(keeper2, world2);
  assert(
    totalOf(inv, '_example:glowing_essence') === 1,
    'output delivered to the restored crafter after the reload',
  );
  crafting = craftingOf(world2, station2);
  assert(
    crafting !== null && crafting.activeJobs.length === 0 && crafting.queue.length === 0,
    'no leftover jobs after completion',
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

function stationOf(snapshot: LocalSnapshot): EntityState | undefined {
  return snapshot.entities.find((e) => e.kind === '_example:workbench');
}

function craftingAt(snapshot: LocalSnapshot, stationId: number): CraftingComponent | null {
  const crafting = byId(snapshot, stationId)?.components.crafting;
  return isCrafting(crafting) ? crafting : null;
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
    if (this.snapshots.length > 500) this.snapshots.shift();
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
    timeoutMs = 8000,
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

/** The nearest non-wall tile on a Chebyshev ring around (x, y). */
function walkableNear(
  snapshot: LocalSnapshot,
  x: number,
  y: number,
  radius: number,
): { x: number; y: number } {
  const walls = new Set(
    snapshot.tiles.filter((t) => t.kind === 'wall').map((t) => `${t.x},${t.y}`),
  );
  let maxX = 0;
  let maxY = 0;
  for (const tile of snapshot.tiles) {
    if (tile.x > maxX) maxX = tile.x;
    if (tile.y > maxY) maxY = tile.y;
  }
  for (let r = 1; r <= radius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const absDx = dx < 0 ? -dx : dx;
        const absDy = dy < 0 ? -dy : dy;
        if (absDx !== r && absDy !== r) continue; // Chebyshev ring edge only
        const tx = x + dx;
        const ty = y + dy;
        if (tx < 0 || ty < 0 || tx > maxX || ty > maxY) continue;
        if (walls.has(`${tx},${ty}`)) continue;
        return { x: tx, y: ty };
      }
    }
  }
  return { x, y }; // fallback: nowhere to walk — use the tile we are on
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

async function waitArrived(
  client: TestClient,
  targetX: number,
  targetY: number,
  what: string,
): Promise<void> {
  await client.waitFor(
    (s) => {
      const e = byId(s, client.entityId);
      return e !== undefined && e.x === targetX && e.y === targetY;
    },
    what,
    30000,
  );
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

    // ── set up: inputs + a workbench next to A ──
    a.send({ t: 'intent', kind: '_example:give', item: '_example:herb', count: 2 });
    a.send({ t: 'intent', kind: '_example:give', item: '_example:vial', count: 1 });
    await a.waitFor(
      (s) =>
        totalOfEntity(byId(s, a.entityId), '_example:herb') === 2 &&
        totalOfEntity(byId(s, a.entityId), '_example:vial') === 1,
      'A holds 2 herb + 1 vial',
    );
    a.send({ t: 'intent', kind: '_example:station' });
    let snap = await a.waitFor((s) => stationOf(s) !== undefined, 'workbench spawned');
    const station = stationOf(snap)!;
    const aPos = byId(snap, a.entityId)!;
    const dx = station.x - aPos.x;
    const dy = station.y - aPos.y;
    assert(dx >= -1 && dx <= 1 && dy >= -1 && dy <= 1, 'workbench spawned adjacent to A');

    // ── craft: inputs consumed, progress visible in BOTH clients ──
    a.send({
      t: 'intent',
      kind: 'craft',
      recipeId: '_example:glowing_essence',
      stationEntityId: station.id,
    });
    snap = await a.waitFor((s) => {
      const c = craftingAt(s, station.id);
      return (
        c !== null &&
        c.activeJobs.some((j) => j.recipeId === '_example:glowing_essence' && j.progress >= 3)
      );
    }, 'A sees the craft job at 3+ ticks');
    await b.waitFor((s) => {
      const c = craftingAt(s, station.id);
      return (
        c !== null &&
        c.activeJobs.some((j) => j.recipeId === '_example:glowing_essence' && j.progress >= 3)
      );
    }, 'B sees the same job progressing');
    assert(
      totalOfEntity(byId(snap, a.entityId), '_example:herb') === 0 &&
        totalOfEntity(byId(snap, a.entityId), '_example:vial') === 0,
      'inputs consumed at craft start',
    );

    // ── walking away mid-craft: the job is not cancelled, not duplicated ──
    const walkAway = { x: aPos.x + 3, y: aPos.y };
    await walkTo(a, walkAway.x, walkAway.y);
    await waitArrived(a, walkAway.x, walkAway.y, 'A walked away mid-craft');
    await a.waitFor(
      (s) => totalOfEntity(byId(s, a.entityId), '_example:glowing_essence') === 1,
      'craft completed while A was away — output delivered',
    );
    snap = a.latest()!;
    const craftingAfter = craftingAt(snap, station.id);
    assert(
      craftingAfter === null || craftingAfter.activeJobs.length === 0,
      'no leftover job after completion (no duplication)',
    );
    assert(
      totalOfEntity(byId(snap, a.entityId), '_example:glowing_essence') === 1,
      'exactly one essence — the walk-away duplicated nothing',
    );

    // Walk back to the station for everything that follows.
    await walkTo(a, station.x, station.y);
    await waitArrived(a, station.x, station.y, 'A walked back to the station');

    // ── forged craft for a recipe whose inputs you lack: rejected ──
    a.send({
      t: 'intent',
      kind: 'craft',
      recipeId: '_example:polished_stone',
      stationEntityId: station.id,
    });
    await sleep(300);
    snap = a.latest()!;
    const craftingForged = craftingAt(snap, station.id);
    assert(
      craftingForged === null ||
        !craftingForged.activeJobs.some((j) => j.recipeId === '_example:polished_stone'),
      'forged craft with missing inputs rejected — no job created',
    );
    assert(
      totalOfEntity(byId(snap, a.entityId), '_example:stone') === 0,
      'forged craft consumed nothing',
    );

    // ── cancelCraft refunds exactly the inputs ──
    a.send({ t: 'intent', kind: '_example:give', item: '_example:herb', count: 2 });
    a.send({ t: 'intent', kind: '_example:give', item: '_example:vial', count: 1 });
    await a.waitFor(
      (s) =>
        totalOfEntity(byId(s, a.entityId), '_example:herb') === 2 &&
        totalOfEntity(byId(s, a.entityId), '_example:vial') === 1,
      'A holds 2 herb + 1 vial again',
    );
    a.send({
      t: 'intent',
      kind: 'craft',
      recipeId: '_example:glowing_essence',
      stationEntityId: station.id,
    });
    await a.waitFor((s) => {
      const c = craftingAt(s, station.id);
      return c !== null && c.activeJobs.some((j) => j.crafterEntityId === a.entityId);
    }, 'cancel test: job exists');
    a.send({ t: 'intent', kind: 'cancelCraft', jobIndex: 0, stationEntityId: station.id });
    await a.waitFor((s) => {
      const c = craftingAt(s, station.id);
      return c === null || c.activeJobs.length === 0;
    }, 'cancel test: job removed');
    snap = a.latest()!;
    assert(
      totalOfEntity(byId(snap, a.entityId), '_example:herb') === 2 &&
        totalOfEntity(byId(snap, a.entityId), '_example:vial') === 1 &&
        totalOfEntity(byId(snap, a.entityId), '_example:glowing_essence') === 1,
      'cancel refunded exactly the inputs — no dupe, no loss',
    );

    // ── THE INTEROP TEST end-to-end: farming seeds feed _example's recipe ──
    // Drop A's remaining herbs so the only herb-tagged items left are the
    // seeds registered by the farming feature.
    const herbSlot = invOfEntity(byId(snap, a.entityId))!.slots.findIndex(
      (s) => s.itemId === '_example:herb',
    );
    a.send({ t: 'intent', kind: 'drop', slot: herbSlot });
    await a.waitFor(
      (s) => totalOfEntity(byId(s, a.entityId), '_example:herb') === 0,
      'herbs dropped',
    );
    a.send({ t: 'intent', kind: 'farming:give' });
    await a.waitFor(
      (s) => totalOfEntity(byId(s, a.entityId), 'farming:seed') === 4,
      'A holds 4 farming seeds',
    );
    a.send({
      t: 'intent',
      kind: 'craft',
      recipeId: '_example:glowing_essence',
      stationEntityId: station.id,
    });
    await a.waitFor(
      (s) =>
        totalOfEntity(byId(s, a.entityId), '_example:glowing_essence') === 2 &&
        totalOfEntity(byId(s, a.entityId), 'farming:seed') === 2 &&
        totalOfEntity(byId(s, a.entityId), '_example:vial') === 0,
      "farming's seeds were consumed by _example's recipe — essence produced",
    );

    // Drop the leftover seeds first: they carry the 'herb' tag too, and the
    // parallel-test craft must consume the _example herbs, not them. The
    // station tile already holds the herb ground drop (one item per tile),
    // so drop the seeds from a free tile instead.
    const freshSnap = a.latest()!;
    const seedSlot = invOfEntity(byId(freshSnap, a.entityId))!.slots.findIndex(
      (s) => s.itemId === 'farming:seed',
    );
    const seedDropTile = walkableNear(freshSnap, station.x, station.y, 2);
    await walkTo(a, seedDropTile.x, seedDropTile.y);
    await waitArrived(a, seedDropTile.x, seedDropTile.y, 'A moved to a free tile');
    a.send({ t: 'intent', kind: 'drop', slot: seedSlot });
    await a.waitFor(
      (s) => totalOfEntity(byId(s, a.entityId), 'farming:seed') === 0,
      'leftover seeds dropped',
    );
    await walkTo(a, station.x, station.y);
    await waitArrived(a, station.x, station.y, 'A back at the station');

    // ── two players at the same station: parallel jobs ──
    b.send({ t: 'intent', kind: '_example:give', item: '_example:stone', count: 3 });
    await b.waitFor(
      (s) => totalOfEntity(byId(s, b.entityId), '_example:stone') === 3,
      'B holds 3 stone',
    );
    await walkTo(b, station.x, station.y);
    await waitArrived(b, station.x, station.y, 'B stands at the station');
    a.send({ t: 'intent', kind: '_example:give', item: '_example:herb', count: 2 });
    a.send({ t: 'intent', kind: '_example:give', item: '_example:vial', count: 1 });
    await a.waitFor(
      (s) =>
        totalOfEntity(byId(s, a.entityId), '_example:herb') === 2 &&
        totalOfEntity(byId(s, a.entityId), '_example:vial') === 1,
      'A re-stocked for the parallel test',
    );
    a.send({
      t: 'intent',
      kind: 'craft',
      recipeId: '_example:glowing_essence',
      stationEntityId: station.id,
    });
    b.send({
      t: 'intent',
      kind: 'craft',
      recipeId: '_example:polished_stone',
      stationEntityId: station.id,
    });
    await b.waitFor((s) => {
      const c = craftingAt(s, station.id);
      return c !== null && c.activeJobs.length === 2 && c.activeJobs.every((j) => j.progress >= 1);
    }, 'both jobs active in parallel at the same station');
    await a.waitFor(
      (s) =>
        totalOfEntity(byId(s, a.entityId), '_example:glowing_essence') === 3 &&
        totalOfEntity(byId(s, b.entityId), '_example:polished_stone') === 1,
      'both parallel crafts completed, outputs delivered to the right players',
    );

    // ── per-player queue: A's second craft waits for A's first ──
    a.send({ t: 'intent', kind: '_example:give', item: '_example:herb', count: 2 });
    a.send({ t: 'intent', kind: '_example:give', item: '_example:vial', count: 1 });
    a.send({ t: 'intent', kind: '_example:give', item: '_example:stone', count: 3 });
    await a.waitFor(
      (s) =>
        totalOfEntity(byId(s, a.entityId), '_example:herb') === 2 &&
        totalOfEntity(byId(s, a.entityId), '_example:vial') === 1 &&
        totalOfEntity(byId(s, a.entityId), '_example:stone') === 3,
      'A re-stocked for the queue test',
    );
    a.send({
      t: 'intent',
      kind: 'craft',
      recipeId: '_example:glowing_essence',
      stationEntityId: station.id,
    });
    a.send({
      t: 'intent',
      kind: 'craft',
      recipeId: '_example:polished_stone',
      stationEntityId: station.id,
    });
    await a.waitFor((s) => {
      const c = craftingAt(s, station.id);
      return c !== null && c.queue.some((j) => j.recipeId === '_example:polished_stone');
    }, "A's second craft queued behind A's active craft");
    await a.waitFor(
      (s) => totalOfEntity(byId(s, a.entityId), '_example:glowing_essence') === 4,
      "A's active craft completed",
    );
    await a.waitFor(
      (s) => totalOfEntity(byId(s, a.entityId), '_example:polished_stone') === 1,
      "A's queued craft promoted and completed",
    );
    snap = a.latest()!;
    const craftingQueue = craftingAt(snap, station.id);
    assert(
      craftingQueue === null ||
        (craftingQueue.activeJobs.length === 0 && craftingQueue.queue.length === 0),
      'station idle after the queue drained',
    );

    // ── server restart mid-craft: the job resumes at its progress ──
    a.send({ t: 'intent', kind: '_example:give', item: '_example:herb', count: 2 });
    a.send({ t: 'intent', kind: '_example:give', item: '_example:vial', count: 1 });
    await a.waitFor(
      (s) =>
        totalOfEntity(byId(s, a.entityId), '_example:herb') === 2 &&
        totalOfEntity(byId(s, a.entityId), '_example:vial') === 1,
      'A re-stocked for the restart test',
    );
    a.send({
      t: 'intent',
      kind: 'craft',
      recipeId: '_example:glowing_essence',
      stationEntityId: station.id,
    });
    snap = await a.waitFor((s) => {
      const c = craftingAt(s, station.id);
      return c !== null && c.activeJobs[0]?.progress >= 10;
    }, 'job at 10+ ticks before the restart');
    const essenceBefore = totalOfEntity(byId(snap, a.entityId), '_example:glowing_essence');

    await stopServer(server);
    server = null;
    for (const client of clients) client.close();

    server = startServer();
    await waitListening(server);
    const d = await TestClient.connect('D');
    clients.push(d);

    await d.waitFor((s) => {
      const c = craftingAt(s, station.id);
      // Either the job is still active at its persisted progress, or it
      // finished during the restart — both are acceptable outcomes.
      return c === null || c.activeJobs.length === 0 || c.activeJobs[0].progress >= 10;
    }, 'job resumed at 10+ ticks (or finished during the restart)');
    snap = d.latest()!;
    const resumed = craftingAt(snap, station.id);
    assert(
      resumed === null || resumed.activeJobs.length === 0 || resumed.activeJobs[0].progress >= 10,
      'no job duplication after the restart (at most one job)',
    );
    await d.waitFor(
      (s) => totalOfEntity(byId(s, a.entityId), '_example:glowing_essence') === essenceBefore + 1,
      'restarted job completed and delivered exactly one more essence',
    );
    snap = d.latest()!;
    assert(
      totalOfEntity(byId(snap, a.entityId), '_example:glowing_essence') === essenceBefore + 1,
      'exactly +1 essence — the restart duplicated nothing',
    );

    // ── the station still works after the restart ──
    d.send({ t: 'intent', kind: '_example:give', item: '_example:stone', count: 3 });
    await d.waitFor(
      (s) => totalOfEntity(byId(s, d.entityId), '_example:stone') === 3,
      'D holds 3 stone',
    );
    await walkTo(d, station.x, station.y);
    await waitArrived(d, station.x, station.y, 'D stands at the station');
    d.send({
      t: 'intent',
      kind: 'craft',
      recipeId: '_example:polished_stone',
      stationEntityId: station.id,
    });
    await d.waitFor(
      (s) => totalOfEntity(byId(s, d.entityId), '_example:polished_stone') === 1,
      'crafting works after the restart',
    );

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
    failures === 0 ? '\nALL PHASE 6 TESTS PASSED' : `\n${failures} FAILURE(S) — see above`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
