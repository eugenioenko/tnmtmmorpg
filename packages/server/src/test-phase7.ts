/**
 * Phase 7 verification script (spatial events) — run with
 * `pnpm --filter @game/server test` or `node packages/server/src/test-phase7.ts`.
 *
 * Covers the spatial-events validation gates that are checkable headlessly:
 *  - entityIdsInRadius returns exactly the entities within `radius` tiles
 *    (Chebyshev), across chunk borders, with exact boundary semantics
 *  - emitNear delivers once per nearby entity, with the receiving entity's
 *    id merged into the payload; entities outside the radius never hear it
 *  - regular emit() is untouched: global listeners fire once with the exact
 *    payload, and the two queues never leak into each other
 *  - of 1000 NPCs, a damage event at (5, 5) reaches exactly the handful
 *    within 20 tiles — the spatial index does the filtering, not a scan
 *  - damage at (5, 5) triggers the nearby NPC's chase reaction
 *  - damage at (5000, 5000) triggers NO reaction at (0, 0)
 *  - entity:death is spatial too: nearby entities hear it, the payload
 *    keeps the DEAD entity's id (not the receiver's), and the victim is
 *    despawned
 *
 * And the two features that make it a game, both driven exactly as the
 * server drives them — through their own code, on the sanctioned WorldAPI:
 *  - combat is a FEATURE: damage/death run on world.update/world.despawn,
 *    and a chasing NPC's swing reaches it through the npc feature's
 *    'npc:attack' event
 *  - NPCs are a FEATURE: world.move is the only way it changes a position
 *    and core refuses the tiles it may not stand on; a fresh world seeds
 *    itself once; and another feature registers a behaviour through
 *    'npc:register-ais' with no core registry and no import between them
 *
 * The network/browser gates (health bars, attacks over websockets) are
 * covered by the end-to-end script and manual playtesting — see project.md
 * Phase 7.
 */
import type { EntityState, NPCComponent, StatsComponent, WorldAPI } from '@game/shared';
import { EventBus } from './events.ts';
import { World } from './world.ts';
import { createWorldApi } from './world-api.ts';
// Combat and NPCs both live in features/, not core.
import combatPlugin, { applyAttack } from '../../../features/combat/index.ts';
import npcPlugin, { createNPCSystem, NPC_KIND, spawnNPC } from '../../../features/npc/index.ts';

let failures = 0;

function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ok - ${label}`);
  } else {
    failures++;
    console.error(`  FAIL - ${label}`);
  }
}

function abs(n: number): number {
  return n < 0 ? -n : n;
}

function spawnCombatant(world: World, kind: string, x: number, y: number, atk: number): number {
  return world.spawn(
    kind,
    { x, y },
    {
      stats: { hp: 50, maxHp: 50, atk, def: 2, level: 1 },
    },
  );
}

function npcState(world: World, id: number): NPCComponent {
  return world.get(id)!.components.npc as NPCComponent;
}

function statsOf(world: World, id: number): StatsComponent {
  return world.get(id)!.components.stats as StatsComponent;
}

/** The sanctioned WorldAPI a feature gets, built exactly as the server builds it. */
function featureApi(world: World, bus: EventBus, feature: string): WorldAPI {
  return createWorldApi({
    world,
    bus,
    items: new Map(),
    recipes: new Map(),
    log: (msg: string) => console.log(`[feature:${feature}] ${msg}`),
  });
}

/** The registration callback the npc feature puts in its 'npc:register-ais' payload. */
type RegisterAI = (
  name: string,
  fn: (world: WorldAPI, entity: EntityState, nearby: EntityState[], tick: number) => void,
) => void;

interface Wiring {
  /** The combat feature's own WorldAPI (its log prefix, its detached copies). */
  combat: WorldAPI;
  /** The npc feature's own WorldAPI. */
  npc: WorldAPI;
  /** Run the npc feature's system once, as the tick loop would. */
  runNpcTick: () => void;
}

/**
 * The production wiring, minus the network: each feature gets its own
 * WorldAPI, its event listeners go on the bus against that API, and the npc
 * feature's system is instantiated the way the loader instantiates it.
 *
 * `seed: true` lets the one-time world scatter happen; every other test
 * claims the kv flag up front so its world holds only the NPCs it spawned.
 *
 * Note the npc system's FIRST tick is its bootstrap (offer the behaviour
 * registry, seed a fresh world) and does nothing else — tests that expect an
 * NPC to act run two ticks.
 */
function wireFeatures(world: World, bus: EventBus, options: { seed?: boolean } = {}): Wiring {
  const combat = featureApi(world, bus, 'combat');
  const npc = featureApi(world, bus, 'npc');
  if (!options.seed) world.getSet('npc:seeded', '1');

  const system = createNPCSystem();
  for (const [event, handler] of Object.entries(npcPlugin.events)) {
    bus.on(event, (payload) => handler(npc, payload));
  }
  for (const [event, handler] of Object.entries(combatPlugin.events)) {
    bus.on(event, (payload) => handler(combat, payload));
  }
  return { combat, npc, runNpcTick: () => system(npc, 0.1) };
}

function unitTests(): void {
  console.log('unit: spatial queries (entityIdsInRadius)');
  const world = new World(1000, 1000, 42);
  const a = world.spawn('npc', { x: 0, y: 0 });
  const b = world.spawn('npc', { x: 63, y: 0 });
  const c = world.spawn('npc', { x: 64, y: 0 }); // next chunk over
  const d = world.spawn('npc', { x: 100, y: 100 });

  let ids = world.entityIdsInRadius(0, 0, 70);
  assert(
    ids.has(a) && ids.has(b) && ids.has(c) && !ids.has(d),
    'radius 70 covers (0,0), (63,0) and (64,0) but not (100,100)',
  );
  ids = world.entityIdsInRadius(0, 0, 63);
  assert(
    ids.has(a) && ids.has(b) && !ids.has(c),
    'radius 63 includes the boundary tile at 63, excludes 64',
  );
  ids = world.entityIdsInRadius(0, 0, 0);
  assert(ids.has(a) && ids.size === 1, 'radius 0 reaches only the tile itself');

  world.despawn(b);
  ids = world.entityIdsInRadius(0, 0, 63);
  assert(!ids.has(b), 'despawned entities are never returned');

  console.log('unit: spatial delivery (emitNear)');
  const bus = new EventBus();
  const deliveryWorld = new World(1000, 1000, 42);
  const near = deliveryWorld.spawn('npc', { x: 5, y: 5 });
  const mid = deliveryWorld.spawn('npc', { x: 20, y: 5 }); // 15 tiles away: inside radius 20
  const far = deliveryWorld.spawn('npc', { x: 500, y: 500 });
  const received: unknown[] = [];
  bus.on('test:hit', (payload) => received.push(payload));

  bus.emitNear(5, 5, 20, 'test:hit', { note: 'x' });
  bus.flush(); // regular flush must not deliver spatial events
  assert(received.length === 0, 'flush() does not deliver spatial events');
  bus.flushSpatial(deliveryWorld);
  const gotIds = received.map((p) => (p as { entityId: number }).entityId).sort((m, n) => m - n);
  assert(
    gotIds.join(',') === [near, mid].sort((m, n) => m - n).join(','),
    'each of the 2 entities within radius received the event once',
  );
  assert(
    received.every((p) => (p as { note: string }).note === 'x'),
    'the payload fields survive delivery',
  );
  assert(!gotIds.includes(far), 'the entity 495 tiles away never heard the event');

  received.length = 0;
  bus.emit('test:hit', { note: 'global' });
  bus.flushSpatial(deliveryWorld); // spatial flush must not deliver regular events
  assert(received.length === 0, 'flushSpatial() does not deliver regular events');
  bus.flush();
  assert(received.length === 1, 'regular emit() still delivers once, globally');
  assert(
    (received[0] as { note: string }).note === 'global',
    'regular listeners receive the exact payload, no entityId merged',
  );

  // An event nobody listens to drains without error.
  bus.emitNear(5, 5, 20, 'nobody:listens', {});
  bus.flushSpatial(deliveryWorld);
  assert(true, 'emitNear for an unregistered event drains cleanly');

  console.log('unit: 1000 NPCs, one hit reaches only the nearby');
  const popWorld = new World(10000, 10000, 42);
  const popBus = new EventBus();
  const popApi = featureApi(popWorld, popBus, 'npc');
  let deliveries = 0;
  popBus.on('entity:damage', () => deliveries++);
  for (let i = 0; i < 1000; i++) {
    spawnNPC(popApi, NPC_KIND, i * 10, 0, 'wander');
  }
  popBus.emitNear(5, 5, 20, 'entity:damage', {
    targetId: 0,
    sourceId: 0,
    amount: 1,
    rawAmount: 1,
  });
  popBus.flushSpatial(popWorld);
  assert(
    deliveries === 3,
    `of 1000 NPCs, exactly the 3 within 20 tiles of (5,5) received the damage (got ${deliveries})`,
  );

  console.log('unit: damage at (5, 5) triggers the nearby NPC reaction');
  const nearWorld = new World(1000, 1000, 42);
  const nearBus = new EventBus();
  const nearWiring = wireFeatures(nearWorld, nearBus);
  const victimNpc = spawnNPC(nearWiring.npc, NPC_KIND, 5, 5, 'wander');
  const attacker = spawnCombatant(nearWorld, 'player', 5, 6, 8);
  const bystander = spawnNPC(nearWiring.npc, NPC_KIND, 7, 7, 'wander');
  applyAttack(nearWiring.combat, attacker, victimNpc);
  nearBus.flush();
  nearBus.flushSpatial(nearWorld);
  assert(
    npcState(nearWorld, victimNpc).state === 'chasing' &&
      npcState(nearWorld, victimNpc).target === attacker,
    'damage at (5,5): the nearby NPC drops what it was doing and chases the attacker',
  );
  assert(
    npcState(nearWorld, bystander).state === 'idle',
    'an unharmed bystander NPC stays idle — only the victim reacts',
  );

  console.log('unit: damage at (5000, 5000) triggers no reaction at (0, 0)');
  const farWorld = new World(10000, 10000, 42);
  const farBus = new EventBus();
  const farWiring = wireFeatures(farWorld, farBus);
  const originNpc = spawnNPC(farWiring.npc, NPC_KIND, 1, 1, 'wander');
  const farVictim = spawnNPC(farWiring.npc, NPC_KIND, 5000, 5000, 'wander');
  const farAttacker = spawnCombatant(farWorld, 'player', 5000, 5001, 8);
  applyAttack(farWiring.combat, farAttacker, farVictim);
  farBus.flush();
  farBus.flushSpatial(farWorld);
  assert(
    npcState(farWorld, originNpc).state === 'idle',
    'damage at (5000,5000): the NPC at (1,1) stays idle — the event never reached it',
  );
  assert(
    npcState(farWorld, farVictim).state === 'chasing' &&
      npcState(farWorld, farVictim).target === farAttacker,
    'the damaged NPC at (5000,5000) itself chases the attacker',
  );

  console.log('unit: entity:death is spatial, payload keeps the dead entity id');
  const dWorld = new World(1000, 1000, 42);
  const dBus = new EventBus();
  const dWiring = wireFeatures(dWorld, dBus);
  const victim = spawnNPC(dWiring.npc, NPC_KIND, 5, 5, 'wander'); // hp 30
  const killer = spawnCombatant(dWorld, 'player', 5, 6, 100); // one-shots the victim
  const deathHearer = spawnNPC(dWiring.npc, NPC_KIND, 9, 5, 'wander'); // within 30 tiles
  const farNpc = spawnNPC(dWiring.npc, NPC_KIND, 400, 400, 'wander');
  const deaths: unknown[] = [];
  dBus.on('entity:death', (payload) => deaths.push(payload));
  applyAttack(dWiring.combat, killer, victim);
  dBus.flush();
  dBus.flushSpatial(dWorld);
  assert(dWorld.get(victim) === undefined, 'the victim despawns on death');
  assert(
    deaths.length === 2,
    `death heard by exactly the 2 entities within 30 tiles (got ${deaths.length})`,
  );
  assert(
    deaths.every((p) => (p as { entityId: number }).entityId === victim),
    'death payloads preserve the DEAD entity id (not the receiver id)',
  );
  assert(
    npcState(dWorld, deathHearer).state === 'idle',
    'a hearer of the death stays idle (no reaction to others dying)',
  );
  assert(npcState(dWorld, farNpc).state === 'idle', 'the NPC 400 tiles away never heard the death');
}

/**
 * Combat as a FEATURE: the damage rules run entirely on the sanctioned
 * WorldAPI (get -> update -> despawn), reach players through the
 * 'combat:attack' command and NPCs through the npc feature's 'npc:attack'.
 */
function combatFeatureTests(): void {
  console.log('unit: world.update — the component mutation surface');
  const uWorld = new World(1000, 1000, 42);
  const uApi = featureApi(uWorld, new EventBus(), 'combat');
  const patched = uWorld.spawn(
    'npc',
    { x: 3, y: 4 },
    { stats: { hp: 10, maxHp: 10, atk: 1, def: 0, level: 1 } },
  );
  assert(
    uApi.update(patched, { stats: { hp: 4, maxHp: 10, atk: 1, def: 0, level: 1 } }),
    'update() returns true for a live entity',
  );
  assert(statsOf(uWorld, patched).hp === 4, 'the patch lands on the LIVE entity, not a copy');
  uApi.update(patched, { buff: { kind: 'haste' } });
  assert(
    (uWorld.get(patched)!.components.buff as { kind: string }).kind === 'haste' &&
      statsOf(uWorld, patched).hp === 4,
    'the merge is shallow: a new component is added, the others are untouched',
  );
  uApi.update(patched, { id: 99, kind: 'player', x: 500, y: 500, chunk: '9,9' });
  const untouched = uWorld.get(patched)!;
  assert(
    untouched.id === patched &&
      untouched.kind === 'npc' &&
      untouched.x === 3 &&
      untouched.y === 4 &&
      untouched.components.x === undefined,
    'id/kind/x/y/chunk are ignored — position changes go through move()',
  );
  assert(uApi.update(999_999, { stats: {} }) === false, 'update() returns false for a missing id');

  console.log('unit: the combat feature applies the damage formula');
  const fWorld = new World(1000, 1000, 42);
  const fBus = new EventBus();
  const { combat: api } = wireFeatures(fWorld, fBus);
  const target = spawnCombatant(fWorld, 'npc', 10, 10, 8); // hp 50, def 2
  const player = spawnCombatant(fWorld, 'player', 10, 11, 15); // atk 15
  applyAttack(api, player, target);
  assert(
    statsOf(fWorld, target).hp === 36,
    `atk 15 vs def 2 removes max(1, floor(15 - 1)) = 14 hp (got ${statsOf(fWorld, target).hp})`,
  );

  const farTarget = spawnCombatant(fWorld, 'npc', 40, 40, 8);
  applyAttack(api, player, farTarget);
  assert(statsOf(fWorld, farTarget).hp === 50, 'a target 30 tiles away takes no damage');

  const statless = fWorld.spawn('_example:totem', { x: 10, y: 9 });
  applyAttack(api, player, statless);
  assert(
    fWorld.get(statless) !== undefined && fWorld.get(statless)!.components.stats === undefined,
    'an entity without stats is untargetable — nothing is written to it',
  );

  console.log("unit: the 'combat:attack' command (what the client's click sends)");
  const command = combatPlugin.commands.find((c) => c.name === 'combat:attack');
  assert(command !== undefined, "the feature registers a 'combat:attack' command");
  command?.fn(api, { targetId: target }, player);
  assert(statsOf(fWorld, target).hp === 22, 'the command applies exactly one hit');
  command?.fn(api, { targetId: 'not-a-number' }, player);
  command?.fn(api, undefined, player);
  assert(statsOf(fWorld, target).hp === 22, 'a malformed targetId is rejected, never applied');

  console.log("unit: a chasing NPC's swing reaches combat through 'npc:attack'");
  const cWorld = new World(1000, 1000, 42);
  const cBus = new EventBus();
  const cWiring = wireFeatures(cWorld, cBus);
  const brawler = spawnNPC(cWiring.npc, NPC_KIND, 20, 20, 'wander'); // atk 8
  const prey = spawnCombatant(cWorld, 'player', 20, 21, 15); // hp 50, def 2
  const brawlerNpc = npcState(cWorld, brawler);
  brawlerNpc.state = 'chasing';
  brawlerNpc.target = prey;
  cWiring.runNpcTick(); // tick 1 is the feature's one-time bootstrap...
  cWiring.runNpcTick(); // ...tick 2 announces the swing...
  cBus.flush(); // ...and the combat feature's listener turns it into damage
  assert(
    statsOf(cWorld, prey).hp === 43,
    `the NPC's swing removes max(1, floor(8 - 1)) = 7 hp (got ${statsOf(cWorld, prey).hp})`,
  );
  cBus.flushSpatial(cWorld);

  // With no feature listening, the announcement is inert — this is what
  // "combat is a feature" buys: uninstall it and the world still runs.
  const iWorld = new World(1000, 1000, 42);
  const iBus = new EventBus();
  const iApi = featureApi(iWorld, iBus, 'npc');
  iWorld.getSet('npc:seeded', '1');
  const bareSystem = createNPCSystem();
  const lonelyNpc = spawnNPC(iApi, NPC_KIND, 20, 20, 'wander');
  const safePrey = spawnCombatant(iWorld, 'player', 20, 21, 15);
  const lonelyState = npcState(iWorld, lonelyNpc);
  lonelyState.state = 'chasing';
  lonelyState.target = safePrey;
  bareSystem(iApi, 0.1); // bootstrap tick
  bareSystem(iApi, 0.1); // the swing tick
  iBus.flush();
  assert(
    statsOf(iWorld, safePrey).hp === 50,
    'without the combat feature installed, an NPC swing is inert — nobody deals damage',
  );
}

/**
 * NPCs as a FEATURE: it owns the brains, core owns the map. Every position
 * change is a world.move() request core is free to refuse, and the behaviour
 * registry lives here, not in a core registry.
 */
function npcFeatureTests(): void {
  console.log('unit: world.move — the position mutation surface');
  const mWorld = new World(100, 100, 42);
  const mApi = featureApi(mWorld, new EventBus(), 'npc');
  // Pin the tiles this test walks on: the noise generator owns everything else.
  for (const x of [0, 9, 10, 11, 12]) mWorld.setTile(x, 10, 'grass');
  const walker = mWorld.spawn('npc', { x: 10, y: 10 });
  assert(mApi.move(walker, 11, 10), 'move() onto a walkable tile succeeds');
  assert(mWorld.get(walker)!.x === 11, 'the entity actually moved');

  mWorld.setTile(12, 10, 'water');
  assert(mApi.move(walker, 12, 10) === false, 'move() into water is refused — core owns collision');
  assert(mWorld.get(walker)!.x === 11, 'a refused move changes nothing');

  assert(
    mApi.move(walker, 100, 10) && mWorld.get(walker)!.x === 0,
    'coordinates wrap around the torus, exactly as core movement does',
  );
  assert(
    mWorld.entityIdsInRadius(0, 10, 0).has(walker),
    'the spatial index followed the move — the feature never touches it',
  );
  assert(mApi.move(999_999, 5, 5) === false, 'move() returns false for a missing id');
  assert(
    mApi.walkable(11, 10) && !mApi.walkable(12, 10),
    'walkable() reports the same rule move() enforces',
  );

  console.log('unit: spatial sleeping and the wander step');
  const wWorld = new World(1000, 1000, 42);
  const wBus = new EventBus();
  const wWiring = wireFeatures(wWorld, wBus);
  const sleeper = spawnNPC(wWiring.npc, NPC_KIND, 500, 500, 'wander');
  const awake = spawnNPC(wWiring.npc, NPC_KIND, 100, 100, 'wander');
  wWorld.spawn('player', { x: 101, y: 100 });
  const before = { ...npcState(wWorld, sleeper) };
  for (let i = 0; i < 40; i++) wWiring.runNpcTick();
  assert(
    npcState(wWorld, sleeper).state === before.state &&
      npcState(wWorld, sleeper).lastActionTick === before.lastActionTick,
    'an NPC 400 tiles from the nearest player never ran its AI',
  );
  const moved = wWorld.get(awake)!;
  assert(
    npcState(wWorld, awake).state !== 'idle' || moved.x !== 100 || moved.y !== 100,
    'an NPC with a player nearby woke up and acted',
  );
  assert(
    abs(moved.x - 100) <= 8 && abs(moved.y - 100) <= 8,
    `40 ticks at speed 0.2 moves at most 8 tiles (landed at ${moved.x}, ${moved.y})`,
  );

  console.log('unit: a fresh world seeds its own population');
  const sWorld = new World(200, 200, 42);
  const sBus = new EventBus();
  const sWiring = wireFeatures(sWorld, sBus, { seed: true });
  sWiring.runNpcTick();
  const seeded = sWorld.query('npc');
  assert(seeded.length === 20, `a fresh world scatters 20 NPCs (got ${seeded.length})`);
  assert(
    seeded.every((e) => abs(e.x - 100) <= 10 && abs(e.y - 100) <= 10),
    'all of them land in the box at the world centre, where players spawn',
  );
  assert(sWorld.getSet('npc:seeded') === '1', 'the one-time kv flag is claimed');
  const restarted = createNPCSystem();
  restarted(sWiring.npc, 0.1);
  assert(sWorld.query('npc').length === 20, 'a restart does not double-seed');

  console.log("unit: another feature registers a behaviour via 'npc:register-ais'");
  const rWorld = new World(1000, 1000, 42);
  const rBus = new EventBus();
  const rWiring = wireFeatures(rWorld, rBus);
  let ranBrain = 0;
  let ranBoom = 0;
  rBus.on('npc:register-ais', (payload) => {
    const register = (payload as { register?: unknown }).register as RegisterAI | undefined;
    assert(typeof register === 'function', 'the offer carries a register callback');
    if (typeof register !== 'function') return;
    register('test:brain', (_world, entity) => {
      ranBrain++;
      (entity.components.npc as NPCComponent).state = 'fleeing';
    });
    register('test:boom', () => {
      ranBoom++;
      throw new Error('this behaviour is broken');
    });
    register('wander', () => assert(false, "'wander' must not be overridable"));
  });
  const brainy = spawnNPC(rWiring.npc, NPC_KIND, 10, 10, 'test:brain');
  const broken = spawnNPC(rWiring.npc, NPC_KIND, 14, 10, 'test:boom');
  rWorld.spawn('player', { x: 12, y: 10 }); // keeps both awake

  rWiring.runNpcTick(); // tick 1: the bootstrap tick puts the offer on the bus
  rBus.flush(); // the other feature answers
  assert(ranBrain === 0, 'no behaviour ran before the offer was answered');
  rWiring.runNpcTick(); // tick 2: the registered behaviours run
  assert(ranBrain === 1, 'a behaviour registered by another feature runs the next tick');
  assert(
    npcState(rWorld, brainy).state === 'fleeing',
    'its component mutations are written back to the live entity',
  );

  for (let i = 0; i < 5; i++) rWiring.runNpcTick();
  assert(
    ranBoom === 3,
    `a throwing behaviour is dropped after 3 strikes (ran ${ranBoom} times in 6 ticks)`,
  );
  assert(
    rWorld.get(broken) !== undefined && npcState(rWorld, broken).ai === 'test:boom',
    'its NPC keeps ticking on the built-in wander instead of taking the system down',
  );
  assert(ranBrain === 6, 'the healthy behaviour is untouched by the broken one');
}

async function main(): Promise<void> {
  unitTests();
  combatFeatureTests();
  npcFeatureTests();
  console.log(
    failures === 0
      ? '\nALL PHASE 7 (SPATIAL EVENTS) TESTS PASSED'
      : `\n${failures} FAILURE(S) — see above`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
