import type { DeathEvent } from '@game/shared';
import { loadAll, loadChunks, openDb } from './db.ts';
import { EventBus } from './events.ts';
import { createGuard } from './guard.ts';
import { loadFeatures } from './loader.ts';
import { createTickLoop } from './tick.ts';
import { DEFAULT_WORLD_HEIGHT, DEFAULT_WORLD_SEED, DEFAULT_WORLD_WIDTH, World } from './world.ts';
import { createWorldApi } from './world-api.ts';
import type { InventoryContext } from './systems/inventory.ts';
import { tickCrafting, type CraftingContext } from './systems/crafting.ts';
import { createCombatSystem, type CombatContext } from './systems/combat.ts';
import { NPC_KIND, scatterNPCs } from './npc.ts';
import { createNPCSystem, type NPCAIEntry } from './systems/npc-ai.ts';
import { Profiler } from './profiler.ts';
import { startWsServer } from './ws.ts';

const PORT = Number(process.env.PORT ?? 3000);
const WORLD_DB = process.env.WORLD_DB ?? '../../.data/dev.sqlite';
const WORLD_WIDTH = Number(process.env.WORLD_WIDTH ?? DEFAULT_WORLD_WIDTH);
const WORLD_HEIGHT = Number(process.env.WORLD_HEIGHT ?? DEFAULT_WORLD_HEIGHT);
const WORLD_SEED = Number(process.env.WORLD_SEED ?? DEFAULT_WORLD_SEED);
/** Profiling: log per-system timing, memory and snapshot sizes every 100 ticks. */
const PROFILE = process.env.PROFILE === '1' || process.argv.includes('--profile');

async function main(): Promise<void> {
  // Open the database first: the world starts from whatever state it holds.
  const db = openDb(WORLD_DB);
  const world = new World(WORLD_WIDTH, WORLD_HEIGHT, WORLD_SEED, db);

  const { entities } = loadAll(db);
  const chunks = loadChunks(db);
  if (entities.length > 0) world.loadFromRows(entities);
  world.loadChunks(chunks);
  console.log(
    `[server] world db ${WORLD_DB}: ${entities.length} entities, ${chunks.size} tile chunk(s)` +
      ` (${WORLD_WIDTH}x${WORLD_HEIGHT}, seed ${WORLD_SEED})`,
  );

  // NPCs: on a fresh world, seed a small wandering population near the
  // origin (players spawn there, so the world reads alive from the first
  // moment). NPCs persist like every other entity, so the count check keeps
  // restarts from duplicating them.
  if (world.query(NPC_KIND).length === 0) {
    const spawned = scatterNPCs(world, 20);
    console.log(`[server] spawned ${spawned} wandering NPCs near the origin`);  }

  // ── Phase 4: feature plugins ─────────────────────────────────────────────
  // Loaded once at boot; the registries are immutable afterwards. Entities
  // persisted by a feature that is no longer installed simply load as
  // unknown kinds — inert, but never a crash.
  const { features, registries } = await loadFeatures();
  console.log(
    `[server] loaded ${features.length} feature(s): ${features.map((f) => f.name).join(', ')}`,
  );

  // The event bus queues emits during systems and commands, and the guard
  // wraps every system, command and listener: one broken feature degrades
  // to "that feature is off", never "the server is down".
  const bus = new EventBus();
  const profiler = new Profiler(PROFILE);
  const guard = createGuard({
    onDisabled: (feature, name, reason) => {
      console.error(`[server] feature '${feature}' disabled '${name}': ${reason}`);
    },
    // Every guarded run (feature systems, commands, event listeners, NPC
    // AIs) feeds its wall-clock time into the profiler report.
    onRun: (name, ms) => profiler.recordSystemTime(name, ms),
  });

  // Each feature gets its own WorldAPI with a prefixed logger; the world
  // internals are never exposed. The item registry (Phase 5) powers give()
  // stack limits and tag queries; the recipe registry (Phase 6) powers
  // getAvailableRecipes() for station queries.
  const worldApis = new Map<string, ReturnType<typeof createWorldApi>>();
  for (const feature of features) {
    worldApis.set(
      feature.name,
      createWorldApi({
        world,
        bus,
        items: registries.items,
        recipes: registries.recipes,
        log: (msg: string) => console.log(`[feature:${feature.name}] ${msg}`),
      }),
    );
  }

  // Event listeners: one guarded registration per (feature, event), so a
  // misbehaving listener disables only itself, and other listeners on the
  // same event are untouched.
  for (const [event, listeners] of registries.events) {
    for (const listener of listeners) {
      const api = worldApis.get(listener.feature);
      if (!api) continue; // unreachable: registries are built from the same features
      bus.on(event, (payload) => {
        guard.run(listener.feature, `${listener.feature}:${event}`, () =>
          listener.fn(api, payload),
        );
      });
    }
  }

  /**
   * Tick step 2: systems, then queued events flush. The Phase 6 crafting
   * runtime runs FIRST, before feature systems, so feature systems observe
   * finished crafts (outputs delivered, jobs promoted) in the same tick.
   *
   * It is registered here by core, not by a feature: feature systems only
   * see the WorldAPI (whose copies are detached, so they cannot progress
   * jobs), and the crafting loop must run even when FEATURES env selects no
   * feature that would register it. The runtime is core per project.md — the
   * recipe registry and tag matcher are core; recipes are features.
   */
  const crafting: CraftingContext = {
    world,
    items: registries.items,
    recipes: registries.recipes,
  };

  /**
   * The core NPC system: spatial sleeping (NPCs in chunks with no players
   * nearby cost zero CPU), AI dispatch and best-effort movement. Feature-
   * registered AIs (registries.ais) run guarded, exactly like systems; the
   * built-in 'wander' is core. Registered here by core, not by a feature —
   * the loop must run even when FEATURES env selects no feature that
   * registers an AI, and only core touches the live entity store.
   */
  const npcAis = new Map<string, NPCAIEntry>();
  for (const ai of registries.ais) {
    npcAis.set(ai.name, { feature: ai.feature, name: ai.name, fn: ai.fn });
  }

  /**
   * Phase 7: the core combat system. Attacks are applied synchronously by
   * handleAttack — the tick loop's 'attack' intent handler and the NPC
   * system's chase attacks both call it. Damage and death are announced on
   * the bus; the per-tick system fn (registered in runSystems below) is the
   * hook point for tick-driven combat features (regen, DoTs, buffs), which
   * is why it gets its own sanctioned WorldAPI like any feature would.
   */
  const combat: CombatContext = { world, bus };
  const combatSystem = createCombatSystem();
  const combatApi = createWorldApi({
    world,
    bus,
    items: registries.items,
    recipes: registries.recipes,
    log: (msg: string) => console.log(`[core:combat] ${msg}`),
  });

  const npcSystem = createNPCSystem({
    world,
    ais: npcAis,
    apiFor: (feature) => worldApis.get(feature),
    runGuarded: (feature, name, fn) => guard.run(feature, name, fn),
    combat,
  });

  // Phase 7: an NPC that takes a hit drops what it was doing and chases the
  // attacker. Registered here by core (not by a feature): the listener
  // needs the LIVE entity, which feature listeners never see. Feature
  // listeners on 'entity:damage' fire right alongside it. Combat emits the
  // event spatially (near the victim), so the listener only runs for
  // entities within the damage radius — the victim is always among them.
  bus.on('entity:damage', (payload) => npcSystem.onDamage(payload));

  // Phase 7: announce deaths. Features hook 'entity:death' via plugin.events
  // to award loot, spawn graves, etc. — core only announces and logs. The
  // event is spatial (delivered once per nearby entity), so the log line
  // is deduped per death; the payload's entityId is the dead entity.
  const loggedDeaths = new Set<string>();
  bus.on('entity:death', (payload) => {
    const { entityId, killerId } = payload as Partial<DeathEvent>;
    if (typeof entityId !== 'number') return;
    const key = `${entityId}:${String(killerId ?? 0)}`;
    if (loggedDeaths.has(key)) return;
    if (loggedDeaths.size > 1000) loggedDeaths.clear(); // bounded; a pruned key just re-logs once
    loggedDeaths.add(key);
    console.log(`[server] entity ${entityId} killed by ${killerId ?? 'environment'}`);
  });

  /**
   * Tick step 2: systems, then queued events flush. Core runtimes run
   * FIRST — crafting, the NPC system, then combat — before feature
   * systems, so feature systems observe finished crafts, NPC movement and
   * combat tick work in the same tick. `tick` is the loop's absolute tick
   * number (NPC timers persist across restarts and are keyed against it).
   */
  function runSystems(deltaSeconds: number, tick: number): void {
    // Core runtimes run first (crafting, NPCs, combat), each timed for the
    // profiler report. timeSystem is exactly fn() when profiling is off.
    profiler.timeSystem('core:crafting', () => tickCrafting(crafting));
    profiler.timeSystem('core:npc', () => npcSystem.run(deltaSeconds, tick));
    profiler.timeSystem('core:combat', () => combatSystem.fn(combatApi, deltaSeconds));
    for (const system of registries.systems) {
      const api = worldApis.get(system.feature);
      if (!api) continue;
      guard.run(system.feature, system.name, () => system.fn(api, deltaSeconds));
    }
    bus.flush();
  }

  /** Tick step 1: intents whose kind matches a feature command. */
  function dispatchCommand(entityId: number, kind: string, args: unknown): boolean {
    const command = registries.commands.get(kind);
    if (!command) return false;
    const api = worldApis.get(command.feature);
    if (!api) return false;
    guard.run(command.feature, kind, () => command.fn(api, args, entityId));
    return true;
  }

  // The tick loop and the ws server depend on each other: ticks broadcast
  // through the ws server, ws sessions enqueue intents into the tick loop.
  // Wire them with callbacks. Each closure references the other's const,
  // which is safe because network I/O callbacks only run after this
  // synchronous init completes; neither side runs before tickLoop.start().
  const wsServer = startWsServer(world, {
    port: PORT,
    enqueueIntent: (entityId, intent) => tickLoop.queueIntent({ entityId, intent }),
    // Phase 6: each client receives the recipe registry once on connect.
    recipes: [...registries.recipes.values()],
    // Profiling: snapshot wire sizes per session — JSON and binary both
    // measured in their real encoded byte length.
    onSnapshot: (msg, data) =>
      profiler.recordSnapshotSize(
        typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength,
        msg.t === 'full',
      ),
  });

  // Phase 5: the drop/pickup/transfer/swap intents need the item registry
  // (stack limits) next to the world.
  const inventory: InventoryContext = { world, items: registries.items };

  const tickLoop = createTickLoop(world, {
    broadcast: (buildPlayerSnapshot) => wsServer.broadcast(buildPlayerSnapshot),
    db,
    runSystems,
    // Spatial events (entity:damage, entity:death) flush right after the
    // regular event queue, every tick.
    flushSpatial: () => bus.flushSpatial(world),
    dispatchCommand,
    disabledFeatures: () => guard.disabledSystems(),
    inventory,
    // Phase 6: the craft/cancelCraft intents need the recipe registry too.
    crafting,
    // Phase 7: the 'attack' intent needs world + bus for damage/death events.
    combat,
    profiler,
    sessionCount: () => wsServer.sessionCount(),
  });

  tickLoop.start();

  /**
   * SIGINT/SIGTERM shutdown: stop the tick loop (no more mutations), flush
   * everything still dirty, then exit. The flush is synchronous, so by the
   * time this returns the state is on disk. SIGKILL cannot be caught — the
   * 50-tick flush keeps the worst-case loss at ~5 seconds.
   */
  function shutdown(signal: string): void {
    console.log(`[server] ${signal} received - shutting down`);
    tickLoop.stop();
    world.flushDirty(db);
    wsServer.close();
    db.close();
    console.log('[server] flushed dirty state - bye');
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(
    '[server] fatal boot error:',
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exit(1);
});
