import { loadAll, openDb } from './db.ts';
import { EventBus } from './events.ts';
import { createGuard } from './guard.ts';
import { loadFeatures } from './loader.ts';
import { createTickLoop } from './tick.ts';
import { TILE_CHUNK, World } from './world.ts';
import { createWorldApi } from './world-api.ts';
import type { InventoryContext } from './systems/inventory.ts';
import { tickCrafting, type CraftingContext } from './systems/crafting.ts';
import { startWsServer } from './ws.ts';

const PORT = Number(process.env.PORT ?? 3000);
const WORLD_DB = process.env.WORLD_DB ?? '.data/dev.sqlite';

async function main(): Promise<void> {
  // Open the database first: the world starts from whatever state it holds.
  const db = openDb(WORLD_DB);
  const world = new World();

  const { entities, tiles } = loadAll(db);
  if (entities.length > 0) world.loadFromRows(entities);
  const savedTiles = tiles.find((t) => t.chunk === TILE_CHUNK) ?? tiles[0];
  if (savedTiles && !world.loadTilesBlob(savedTiles.data)) {
    console.warn(
      `[server] stored tilemap in ${WORLD_DB} does not match world size - using a fresh map`,
    );
  }
  console.log(
    `[server] world db ${WORLD_DB}: ${entities.length} entities, ${tiles.length} tile chunk(s)`,
  );

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
  const guard = createGuard({
    onDisabled: (feature, name, reason) => {
      console.error(`[server] feature '${feature}' disabled '${name}': ${reason}`);
    },
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
  function runSystems(deltaSeconds: number): void {
    tickCrafting(crafting);
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
  });

  // Phase 5: the drop/pickup/transfer/swap intents need the item registry
  // (stack limits) next to the world.
  const inventory: InventoryContext = { world, items: registries.items };

  const tickLoop = createTickLoop(world, {
    broadcast: (snapshot) => wsServer.broadcast(snapshot),
    db,
    runSystems,
    dispatchCommand,
    disabledFeatures: () => guard.disabledSystems(),
    inventory,
    // Phase 6: the craft/cancelCraft intents need the recipe registry too.
    crafting,
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
