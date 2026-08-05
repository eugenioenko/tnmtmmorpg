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
 * The network/browser gates (health bars, attacks over websockets) are
 * covered by manual playtesting — see project.md Phase 7.
 */
import type { NPCComponent } from '@game/shared';
import { EventBus } from './events.ts';
import { World } from './world.ts';
import { NPC_KIND, spawnNPC } from './npc.ts';
import { handleAttack, type CombatContext } from './systems/combat.ts';
import { createNPCSystem } from './systems/npc-ai.ts';

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

/** The production wiring: combat emits spatially, core NPCs react on the bus. */
function wireCombatReaction(world: World, bus: EventBus): void {
  const combat: CombatContext = { world, bus };
  const npcSystem = createNPCSystem({
    world,
    ais: new Map(),
    apiFor: () => undefined,
    runGuarded: () => false,
    combat,
  });
  bus.on('entity:damage', (payload) => npcSystem.onDamage(payload));
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
  wireCombatReaction(nearWorld, nearBus);
  const combat: CombatContext = { world: nearWorld, bus: nearBus };
  const victimNpc = spawnNPC(nearWorld, NPC_KIND, 5, 5, 'wander');
  const attacker = spawnCombatant(nearWorld, 'player', 5, 6, 8);
  const bystander = spawnNPC(nearWorld, NPC_KIND, 7, 7, 'wander');
  handleAttack(combat, attacker, victimNpc);
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
  wireCombatReaction(farWorld, farBus);
  const farCombat: CombatContext = { world: farWorld, bus: farBus };
  const originNpc = spawnNPC(farWorld, NPC_KIND, 1, 1, 'wander');
  const farVictim = spawnNPC(farWorld, NPC_KIND, 5000, 5000, 'wander');
  const farAttacker = spawnCombatant(farWorld, 'player', 5000, 5001, 8);
  handleAttack(farCombat, farAttacker, farVictim);
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
  const dCombat: CombatContext = { world: dWorld, bus: dBus };
  const victim = spawnNPC(dWorld, NPC_KIND, 5, 5, 'wander'); // hp 30
  const killer = spawnCombatant(dWorld, 'player', 5, 6, 100); // one-shots the victim
  const deathHearer = spawnNPC(dWorld, NPC_KIND, 9, 5, 'wander'); // within 30 tiles
  const farNpc = spawnNPC(dWorld, NPC_KIND, 400, 400, 'wander');
  const deaths: unknown[] = [];
  dBus.on('entity:death', (payload) => deaths.push(payload));
  handleAttack(dCombat, killer, victim);
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

async function main(): Promise<void> {
  unitTests();
  console.log(
    failures === 0
      ? '\nALL PHASE 7 (SPATIAL EVENTS) TESTS PASSED'
      : `\n${failures} FAILURE(S) — see above`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
