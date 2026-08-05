import type { DatabaseSync } from 'node:sqlite';
import type {
  CancelCraftIntent,
  CraftIntent,
  DropIntent,
  FullSnapshot,
  Intent,
  MoveIntent,
  ServerMessage,
  SwapIntent,
  TransferIntent,
} from '@game/shared';
import type { World } from './world.ts';
import { formatProfileReport, type Profiler } from './profiler.ts';
import { buildSnapshot, forgetSession } from './snapshot.ts';
import { handleCancelCraftIntent, handleCraftIntent } from './intents/craft.ts';
import { handleDropIntent } from './intents/drop.ts';
import { handleMoveIntent } from './intents/move.ts';
import { handlePickupIntent } from './intents/pickup.ts';
import { handleSwapIntent } from './intents/swap.ts';
import { handleTransferIntent } from './intents/transfer.ts';
import type { CraftingContext } from './systems/crafting.ts';
import type { InventoryContext } from './systems/inventory.ts';

export interface QueuedIntent {
  /** Entity the intent was received from; intents never carry their own id. */
  entityId: number;
  intent: Intent;
}

export interface TickLoopOptions {
  /**
   * Called once per tick. Builds one snapshot per connected session: the
   * callback receives the session's entity id and session id and returns
   * that player's snapshot (a full view on connect, deltas afterwards — see
   * snapshot.ts).
   */
  broadcast: (
    buildPlayerSnapshot: (
      entityId: number,
      sessionId: string,
      view?: { x: number; y: number },
    ) => ServerMessage,
  ) => void;
  /** Where dirty world state is persisted; flushed every 50 ticks (5s at 10Hz). */
  db: DatabaseSync;
  /**
   * Feature hook: run registered systems in order, then flush the event bus.
   * A system that needs a tick-based timer counts its own runs — the loop's
   * tick number restarts at 1 on every boot, so the two are the same number.
   */
  /**
   * Feature hook: hand newly-generated chunks to features' decorateChunk
   * hooks. Called at the top of the tick, off the chunk-generation read path.
   */
  decorateChunks?: () => void;
  runSystems?: (deltaSeconds: number) => void;
  /**
   * Feature hook: flush spatially-scoped events (emitNear) after the regular
   * bus flush. Called after runSystems so global listeners fire first and
   * spatial events deliver in the same tick they were emitted.
   */
  flushSpatial?: () => void;
  /** Feature hook: dispatch a non-core intent kind to a registered command. */
  dispatchCommand?: (entityId: number, kind: string, args: unknown) => boolean;
  /** Feature hook: names of auto-disabled systems, surfaced in snapshots. */
  disabledFeatures?: () => string[];
  /** Phase 5: item registry + world for the drop/pickup/transfer/swap intents. */
  inventory?: InventoryContext;
  /** Phase 6: recipe registry + world for the craft/cancelCraft intents. */
  crafting?: CraftingContext;
  /** Profiling: per-tick timing, per-system timings, counts; no-op when off. */
  profiler?: Profiler;
  /** Profiling: current connected session count, read once per tick. */
  sessionCount?: () => number;
}

export interface TickLoop {
  queueIntent(item: QueuedIntent): void;
  start(): void;
  stop(): void;
}

export const TICK_MS = 100; // 10Hz
const RATE_LOG_INTERVAL_MS = 10_000;
const MAX_CATCH_UP_TICKS = 10;

/**
 * The fixed 10Hz tick loop.
 *
 * Runs on a setInterval with an accumulated-delta approach: each interval
 * adds the real elapsed time to an accumulator and runs as many ticks as
 * fit. Timer jitter averages out in the accumulator instead of drifting,
 * and a slow tick catches up by running several ticks back-to-back.
 */
export function createTickLoop(world: World, options: TickLoopOptions): TickLoop {
  const queue: QueuedIntent[] = [];
  let tickNumber = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  // Tick-rate accounting for the periodic log line.
  let rateWindowStart = 0;
  let rateWindowTicks = 0;

  /**
   * Validate an intent against the session it came from, then apply it.
   * Core kinds (move and the Phase 5-6 intents) are delegated to their
   * handlers in intents/*; any other kind is dispatched to the feature
   * command registry, which is a hook passed in by the server.
   *
   * The intent payloads are cast per case: CommandIntent's `kind` is a
   * plain string, which prevents TypeScript from narrowing the union on
   * the discriminant, so the handlers themselves validate every field at
   * runtime exactly as the core code always did.
   */
  function handleIntent({ entityId, intent }: QueuedIntent): void {
    switch (intent.kind) {
      case 'move':
        return handleMoveIntent(world, entityId, intent as MoveIntent);
      case 'drop':
        return handleDropIntent(options.inventory, entityId, intent as DropIntent);
      case 'pickup':
        // PickupIntent carries no payload; the handler takes no intent arg.
        return handlePickupIntent(options.inventory, entityId);
      case 'transfer':
        return handleTransferIntent(options.inventory, entityId, intent as TransferIntent);
      case 'swap':
        return handleSwapIntent(options.inventory, entityId, intent as SwapIntent);
      case 'craft':
        return handleCraftIntent(options.crafting, entityId, intent as CraftIntent);
      case 'cancelCraft':
        return handleCancelCraftIntent(options.crafting, entityId, intent as CancelCraftIntent);
      default: {
        // Feature command: args are everything except the envelope fields.
        // Commands are namespaced ('_example:give'), so core kinds never
        // land here. The runtime shape (t + string kind) was validated by ws.ts.
        const args = { ...intent } as Record<string, unknown>;
        delete args.t;
        delete args.kind;
        if (options.dispatchCommand?.(entityId, intent.kind, args)) return;
        console.warn(
          `[tick] intent kind '${String(intent.kind)}' from entity ${entityId} rejected — no such command`,
        );
      }
    }
  }

  function tickOnce(): void {
    tickNumber++;
    options.profiler?.startTick();

    // 1. Decorate any chunks generated since the last tick, then drain the
    //    intent queue in arrival order. Decoration runs first and here, not
    //    where the chunk was generated: generation happens lazily inside
    //    world.tile(), which snapshot building calls, so spawning there
    //    would mutate the entity store while it is being serialised.
    options.decorateChunks?.();

    while (queue.length > 0) {
      const item = queue.shift();
      if (item) handleIntent(item);
    }

    // 2. Feature systems run in registration order (guarded), then the
    //    queued event bus flushes. The core crafting runtime runs first
    //    inside runSystems, before feature systems. Spatially-scoped events
    //    (entity:damage, entity:death) flush after the regular queue, still
    //    within the same tick.
    if (options.runSystems) options.runSystems(TICK_MS / 1000);
    options.flushSpatial?.();

    // 3. Build and broadcast one snapshot per connected session. The first
    //    snapshot per session is a full view; later ones are per-session
    //    deltas computed by the diff engine in snapshot.ts.
    const disabledFeatures = options.disabledFeatures?.() ?? [];
    options.broadcast((entityId, sessionId, view) => {
      const entity = world.get(entityId);
      if (!entity) {
        // Despawned mid-tick: reset the session's diff state so the next
        // real snapshot is a full resync instead of a delta built against
        // stale state, and reset the client with an empty full snapshot.
        forgetSession(sessionId);
        return emptySnapshot(tickNumber);
      }
      return buildSnapshot(world, entity, tickNumber, disabledFeatures, sessionId, view);
    });

    // 4. Persist dirty world state every 50 ticks. SIGKILL can't be caught,
    //    so the worst case after a crash is losing the last ~5 seconds.
    if (tickNumber % 50 === 0) {
      const dirty = world.dirtyCount;
      world.flushDirty(options.db);
      if (dirty > 0) {
        console.log(
          `[tick] flushed ${dirty} dirty entit${dirty === 1 ? 'y' : 'ies'} at tick ${tickNumber}`,
        );
      }
    }

    // 5. Periodic tick-rate report so drift is visible in the logs.
    rateWindowTicks++;
    const now = performance.now();
    if (now - rateWindowStart >= RATE_LOG_INTERVAL_MS) {
      const rate = (rateWindowTicks / (now - rateWindowStart)) * 1000;
      console.log(`[tick] rate=${rate.toFixed(1)}/s (tick ${tickNumber})`);
      rateWindowStart = now;
      rateWindowTicks = 0;
    }

    // 6. Profiling: close this tick's window (timing, world/session counts;
    //    snapshot sizes arrive via the ws onSnapshot hook) and log a report
    //    every N ticks. All no-ops when profiling is disabled.
    options.profiler?.endTick(tickNumber, world, options.sessionCount?.() ?? 0);
    const report = options.profiler?.maybeReport();
    if (report) {
      console.log(formatProfileReport(report));
    }
  }

  return {
    queueIntent(item: QueuedIntent): void {
      queue.push(item);
    },

    start(): void {
      if (timer) return;
      let last = performance.now();
      let accumulator = 0;
      rateWindowStart = last;
      rateWindowTicks = 0;
      console.log(`[tick] starting at ${TICK_MS}ms per tick`);
      timer = setInterval(() => {
        const now = performance.now();
        accumulator += now - last;
        last = now;
        let ran = 0;
        while (accumulator >= TICK_MS) {
          accumulator -= TICK_MS;
          tickOnce();
          if (++ran >= MAX_CATCH_UP_TICKS) {
            accumulator = 0;
            console.warn('[tick] loop fell behind — dropping accumulated time');
            break;
          }
        }
      }, TICK_MS);
    },

    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

/** A full reset for a session whose entity is gone (despawned mid-tick). */
function emptySnapshot(tick: number): FullSnapshot {
  return { t: 'full', tick, entities: [], tiles: [], playerX: 0, playerY: 0 };
}
