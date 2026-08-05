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
 *  - combat is a FEATURE: damage/death run on the sanctioned WorldAPI
 *    (world.update for hp, world.despawn on death), and a chasing NPC's
 *    swing reaches it through core's 'npc:attack' event
 *
 * The network/browser gates (health bars, attacks over websockets) are
 * covered by the end-to-end script and manual playtesting — see project.md
 * Phase 7.
 */
import type { NPCComponent, StatsComponent, WorldAPI } from '@game/shared';
import { EventBus } from './events.ts';
import { World } from './world.ts';
import { NPC_KIND, spawnNPC } from './npc.ts';
import { createNPCSystem } from './systems/npc-ai.ts';
import { createWorldApi } from './world-api.ts';
// Combat lives in features/, not core: the test drives it exactly as the
// server does — through the feature's own code on the sanctioned WorldAPI.
import combatPlugin, { applyAttack } from '../../../features/combat/index.ts';

let failures = 0;

function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ok - ${label}`);
  } else {
    failures++;
    console.error(`  FAIL - ${label}`);
  }
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
function featureApi(world: World, bus: EventBus): WorldAPI {
  return createWorldApi({
    world,
    bus,
    items: new Map(),
    recipes: new Map(),
    log: (msg: string) => console.log(`[feature:combat] ${msg}`),
  });
}

/**
 * The production wiring, minus the network: the combat feature's event
 * listeners on the bus (against its own WorldAPI), and the core NPC system
 * reacting to 'entity:damage'. Returns the feature's WorldAPI so a test can
 * drive an attack the way the 'combat:attack' command does.
 */
function wireCombat(world: World, bus: EventBus): {
  api: WorldAPI;
  npcSystem: ReturnType<typeof createNPCSystem>;
} {
  const api = featureApi(world, bus);
  const npcSystem = createNPCSystem({
    world,
    ais: new Map(),
    apiFor: () => undefined,
    runGuarded: () => false,
    // Core announces the swing; the feature's 'npc:attack' listener below is
    // what turns it into damage.
    requestAttack: (attackerId, targetId) => bus.emit('npc:attack', { attackerId, targetId }),
  });
  bus.on('entity:damage', (payload) => npcSystem.onDamage(payload));
  for (const [event, handler] of Object.entries(combatPlugin.events)) {
    bus.on(event, (payload) => handler(api, payload));
  }
  return { api, npcSystem };
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
  let deliveries = 0;
  popBus.on('entity:damage', () => deliveries++);
  for (let i = 0; i < 1000; i++) {
    spawnNPC(popWorld, NPC_KIND, i * 10, 0, 'wander');
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
  const { api: nearApi } = wireCombat(nearWorld, nearBus);
  const victimNpc = spawnNPC(nearWorld, NPC_KIND, 5, 5, 'wander');
  const attacker = spawnCombatant(nearWorld, 'player', 5, 6, 8);
  const bystander = spawnNPC(nearWorld, NPC_KIND, 7, 7, 'wander');
  applyAttack(nearApi, attacker, victimNpc);
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
  const { api: farApi } = wireCombat(farWorld, farBus);
  const originNpc = spawnNPC(farWorld, NPC_KIND, 1, 1, 'wander');
  const farVictim = spawnNPC(farWorld, NPC_KIND, 5000, 5000, 'wander');
  const farAttacker = spawnCombatant(farWorld, 'player', 5000, 5001, 8);
  applyAttack(farApi, farAttacker, farVictim);
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
  const dApi = featureApi(dWorld, dBus);
  const victim = spawnNPC(dWorld, NPC_KIND, 5, 5, 'wander'); // hp 30
  const killer = spawnCombatant(dWorld, 'player', 5, 6, 100); // one-shots the victim
  const deathHearer = spawnNPC(dWorld, NPC_KIND, 9, 5, 'wander'); // within 30 tiles
  const farNpc = spawnNPC(dWorld, NPC_KIND, 400, 400, 'wander');
  const deaths: unknown[] = [];
  dBus.on('entity:death', (payload) => deaths.push(payload));
  applyAttack(dApi, killer, victim);
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
 * 'combat:attack' command and NPCs through core's 'npc:attack' event.
 */
function featureTests(): void {
  console.log('unit: world.update — the new mutation surface');
  const uWorld = new World(1000, 1000, 42);
  const uApi = featureApi(uWorld, new EventBus());
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
    'id/kind/x/y/chunk are ignored — position changes go through movement',
  );
  assert(uApi.update(999_999, { stats: {} }) === false, 'update() returns false for a missing id');

  console.log('unit: the combat feature applies the damage formula');
  const fWorld = new World(1000, 1000, 42);
  const fBus = new EventBus();
  const { api } = wireCombat(fWorld, fBus);
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
  const { npcSystem } = wireCombat(cWorld, cBus);
  const brawler = spawnNPC(cWorld, NPC_KIND, 20, 20, 'wander'); // atk 8
  const prey = spawnCombatant(cWorld, 'player', 20, 21, 15); // hp 50, def 2
  const brawlerNpc = npcState(cWorld, brawler);
  brawlerNpc.state = 'chasing';
  brawlerNpc.target = prey;
  npcSystem.run(0.1, 100); // core announces the swing...
  cBus.flush(); // ...the feature's listener turns it into damage
  assert(
    statsOf(cWorld, prey).hp === 43,
    `the NPC's swing removes max(1, floor(8 - 1)) = 7 hp (got ${statsOf(cWorld, prey).hp})`,
  );
  cBus.flushSpatial(cWorld);

  // With no feature listening, core's announcement is inert — this is what
  // "combat is a feature" buys: uninstall it and the world still runs.
  const iWorld = new World(1000, 1000, 42);
  const iBus = new EventBus();
  const lonelyNpc = spawnNPC(iWorld, NPC_KIND, 20, 20, 'wander');
  const safePrey = spawnCombatant(iWorld, 'player', 20, 21, 15);
  const bareSystem = createNPCSystem({
    world: iWorld,
    ais: new Map(),
    apiFor: () => undefined,
    runGuarded: () => false,
    requestAttack: (attackerId, targetId) => iBus.emit('npc:attack', { attackerId, targetId }),
  });
  const lonelyState = npcState(iWorld, lonelyNpc);
  lonelyState.state = 'chasing';
  lonelyState.target = safePrey;
  bareSystem.run(0.1, 100);
  iBus.flush();
  assert(
    statsOf(iWorld, safePrey).hp === 50,
    'without the combat feature installed, an NPC swing is inert — core deals no damage',
  );
}

async function main(): Promise<void> {
  unitTests();
  featureTests();
  console.log(
    failures === 0
      ? '\nALL PHASE 7 (SPATIAL EVENTS) TESTS PASSED'
      : `\n${failures} FAILURE(S) — see above`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
