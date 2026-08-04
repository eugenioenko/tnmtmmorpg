import type { DatabaseSync } from 'node:sqlite';
import type { Direction, EntityState, Intent, Snapshot, TileState, WorldCoord } from '@game/shared';
import type { World } from './world.ts';
import {
  dropItem,
  isInventory,
  pickupItem,
  swapSlots,
  transferItem,
  type InventoryContext,
} from './systems/inventory.ts';
import { cancelCraft, startCraft, type CraftingContext } from './systems/crafting.ts';

export interface QueuedIntent {
  /** Entity the intent was received from; intents never carry their own id. */
  entityId: number;
  intent: Intent;
}

export interface TickLoopOptions {
  /** Called once per tick with the freshly built snapshot. */
  broadcast: (snapshot: Snapshot) => void;
  /** Where dirty world state is persisted; flushed every 50 ticks (5s at 10Hz). */
  db: DatabaseSync;
  /** Feature hook: run registered systems in order, then flush the event bus. */
  runSystems?: (deltaSeconds: number) => void;
  /** Feature hook: dispatch a non-core intent kind to a registered command. */
  dispatchCommand?: (entityId: number, kind: string, args: unknown) => boolean;
  /** Feature hook: names of auto-disabled systems, surfaced in snapshots. */
  disabledFeatures?: () => string[];
  /** Phase 5: item registry + world for the drop/pickup/transfer/swap intents. */
  inventory?: InventoryContext;
  /** Phase 6: recipe registry + world for the craft/cancelCraft intents. */
  crafting?: CraftingContext;
}

export interface TickLoop {
  queueIntent(item: QueuedIntent): void;
  start(): void;
  stop(): void;
}

export const TICK_MS = 100; // 10Hz
const RATE_LOG_INTERVAL_MS = 10_000;
const MAX_CATCH_UP_TICKS = 10;

const DIRECTIONS: readonly Direction[] = ['n', 's', 'e', 'w'];

const DELTA: Record<Direction, WorldCoord> = {
  n: { x: 0, y: -1 },
  s: { x: 0, y: 1 },
  e: { x: 1, y: 0 },
  w: { x: -1, y: 0 },
};

function isDirection(value: unknown): value is Direction {
  return typeof value === 'string' && (DIRECTIONS as readonly string[]).includes(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * Phase 5 transfer validation: the container must exist, be a container, and
 * be adjacent (Chebyshev distance <= 1, including standing on it). The item
 * move itself is delegated to the inventory system.
 */
function handleTransfer(
  ctx: InventoryContext,
  playerId: number,
  containerId: number,
  fromSlot: number,
  dir: 'in' | 'out',
): void {
  const player = ctx.world.get(playerId);
  if (!player) return; // despawned before the queue was drained

  const container = ctx.world.get(containerId);
  if (
    !container ||
    container.kind !== 'container' ||
    !isInventory(container.components.inventory)
  ) {
    console.warn(
      `[tick] entity ${playerId} transfer: container #${containerId} is not a container — rejected`,
    );
    return;
  }
  const dx = container.x - player.x;
  const dy = container.y - player.y;
  if (dx < -1 || dx > 1 || dy < -1 || dy > 1) {
    console.warn(
      `[tick] entity ${playerId} transfer: container #${containerId} is not adjacent — rejected`,
    );
    return;
  }

  const fromEntity = dir === 'in' ? playerId : containerId;
  const toEntity = dir === 'in' ? containerId : playerId;
  if (!transferItem(ctx, fromEntity, fromSlot, toEntity)) {
    console.warn(
      `[tick] entity ${playerId} transfer: nothing moved from slot ${fromSlot} — rejected`,
    );
  }
}

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
   * 'move' and the Phase 5 inventory kinds are core and handled here; any
   * other kind is dispatched to the feature command registry, which is a
   * hook passed in by the server.
   */
  function handleIntent({ entityId, intent }: QueuedIntent): void {
    switch (intent.kind) {
      case 'move': {
        // The entity is bound to the connection; a client-supplied id is forgery.
        if ('id' in intent) {
          console.warn(`[tick] entity ${entityId} tried to move a target entity — rejected`);
          return;
        }
        const dir = intent.dir;
        if (typeof dir !== 'string' || !isDirection(dir)) {
          console.warn(
            `[tick] entity ${entityId} sent invalid move dir '${String(dir)}' — rejected`,
          );
          return;
        }

        const entity = world.get(entityId);
        if (!entity) return; // despawned before the queue was drained

        const delta = DELTA[dir];
        const target = { x: entity.x + delta.x, y: entity.y + delta.y };
        if (!world.isWalkable(target.x, target.y)) return; // wall: authoritative rejection, silently

        entity.x = target.x;
        entity.y = target.y;
        world.markDirty(entityId);
        return;
      }

      case 'drop': {
        if (!options.inventory) {
          console.warn(`[tick] entity ${entityId} drop: no inventory system — rejected`);
          return;
        }
        const slot = intent.slot;
        if (!isInteger(slot)) {
          console.warn(`[tick] entity ${entityId} drop: slot must be an integer — rejected`);
          return;
        }
        if (dropItem(options.inventory, entityId, slot) <= 0) {
          console.warn(
            `[tick] entity ${entityId} drop: slot ${slot} has nothing droppable — rejected`,
          );
        }
        return;
      }

      case 'pickup': {
        if (!options.inventory) {
          console.warn(`[tick] entity ${entityId} pickup: no inventory system — rejected`);
          return;
        }
        if (!pickupItem(options.inventory, entityId)) {
          console.warn(`[tick] entity ${entityId} pickup: nothing to pick up here — rejected`);
        }
        return;
      }

      case 'transfer': {
        if (!options.inventory) {
          console.warn(`[tick] entity ${entityId} transfer: no inventory system — rejected`);
          return;
        }
        const fromSlot = intent.fromSlot;
        const containerId = intent.toContainerId;
        if (!isInteger(fromSlot) || !isInteger(containerId)) {
          console.warn(
            `[tick] entity ${entityId} transfer: fromSlot/toContainerId must be integers — rejected`,
          );
          return;
        }
        const dir = intent.dir === 'out' ? 'out' : 'in';
        handleTransfer(options.inventory, entityId, containerId, fromSlot, dir);
        return;
      }

      case 'swap': {
        if (!options.inventory) {
          console.warn(`[tick] entity ${entityId} swap: no inventory system — rejected`);
          return;
        }
        const a = intent.a;
        const b = intent.b;
        if (!isInteger(a) || !isInteger(b)) {
          console.warn(`[tick] entity ${entityId} swap: slots must be integers — rejected`);
          return;
        }
        if (!swapSlots(options.inventory, entityId, a, b)) {
          console.warn(
            `[tick] entity ${entityId} swap: slots ${a}/${b} cannot be swapped — rejected`,
          );
        }
        return;
      }

      case 'craft': {
        if (!options.crafting) {
          console.warn(`[tick] entity ${entityId} craft: no crafting system — rejected`);
          return;
        }
        const recipeId = intent.recipeId;
        const stationEntityId = intent.stationEntityId;
        if (typeof recipeId !== 'string' || !isInteger(stationEntityId)) {
          console.warn(
            `[tick] entity ${entityId} craft: recipeId/stationEntityId must be a string and an integer — rejected`,
          );
          return;
        }
        const result = startCraft(options.crafting, entityId, stationEntityId, recipeId);
        if (!result.ok) {
          console.warn(`[tick] entity ${entityId} craft '${recipeId}' rejected: ${result.reason}`);
        }
        return;
      }

      case 'cancelCraft': {
        if (!options.crafting) {
          console.warn(`[tick] entity ${entityId} cancelCraft: no crafting system — rejected`);
          return;
        }
        const jobIndex = intent.jobIndex;
        const stationEntityId = intent.stationEntityId;
        if (!isInteger(jobIndex) || !isInteger(stationEntityId)) {
          console.warn(
            `[tick] entity ${entityId} cancelCraft: jobIndex/stationEntityId must be integers — rejected`,
          );
          return;
        }
        const result = cancelCraft(options.crafting, entityId, stationEntityId, jobIndex);
        if (!result.ok) {
          console.warn(
            `[tick] entity ${entityId} cancelCraft at station ${stationEntityId} rejected: ${result.reason}`,
          );
        }
        return;
      }

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

    // 1. Drain the intent queue, in arrival order.
    while (queue.length > 0) {
      const item = queue.shift();
      if (item) handleIntent(item);
    }

    // 2. Feature systems run in registration order (guarded), then the
    //    queued event bus flushes. Core has no systems of its own.
    if (options.runSystems) options.runSystems(TICK_MS / 1000);

    // 3. Build and broadcast the snapshot.
    options.broadcast(buildSnapshot(world, tickNumber, options.disabledFeatures?.() ?? []));

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

function buildSnapshot(world: World, tick: number, disabledFeatures: string[]): Snapshot {
  const tiles: TileState[] = [];
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      tiles.push({ x, y, kind: world.tile(x, y) });
    }
  }

  const entities: EntityState[] = world.all().map((e) => ({
    id: e.id,
    kind: e.kind,
    x: e.x,
    y: e.y,
    components: e.components,
  }));

  const snapshot: Snapshot = { t: 'snapshot', tick, entities, tiles };
  if (disabledFeatures.length > 0) snapshot.disabledFeatures = disabledFeatures;
  return snapshot;
}
