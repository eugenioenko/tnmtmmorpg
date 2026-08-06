import { OVERWORLD } from '@game/shared';
import type { World } from './world.ts';

/**
 * Safety valve: if a listener keeps re-emitting forever, stop flushing so
 * the tick loop cannot be wedged by a runaway handler.
 */
const MAX_FLUSH_ITERATIONS = 1000;

type Listener = (payload: unknown) => void;

/** A queued spatially-scoped event; delivered once per nearby entity on flush. */
export interface SpatialEvent {
  event: string;
  payload: unknown;
  x: number;
  y: number;
  radius: number;
  /** Which world the event happened in; it never crosses into another. */
  world: string;
}

/**
 * Attach the receiving entity's id to a spatial payload. Payload fields are
 * preserved: an event whose payload already defines `entityId` (e.g.
 * 'entity:death', where it names the dead entity) keeps its meaning; the
 * receiver's id fills the slot only when the payload leaves it free (e.g.
 * 'entity:damage'). Non-object payloads are wrapped beside the id.
 */
function withReceiverId(payload: unknown, entityId: number): unknown {
  if (typeof payload === 'object' && payload !== null) {
    return { entityId, ...payload };
  }
  return { entityId, payload };
}

/**
 * The server's event bus. Emits are queued, never delivered inline, so
 * handlers can never fire reentrantly in the middle of a system. The tick
 * flushes the queue after systems run; handlers that emit during a flush
 * enqueue for the next iteration.
 *
 * The bus itself is dumb — the runtime wraps every listener in the guard
 * when it registers, so a throwing or slow handler is isolated per feature.
 */
export class EventBus {
  private readonly listeners = new Map<string, Listener[]>();
  private readonly queue: Array<{ event: string; payload: unknown }> = [];
  private readonly spatialQueue: SpatialEvent[] = [];

  on(event: string, listener: Listener): void {
    const list = this.listeners.get(event);
    if (list) list.push(listener);
    else this.listeners.set(event, [listener]);
  }

  /** Queue an event; it is delivered on the next flush. */
  emit(event: string, payload: unknown): void {
    this.queue.push({ event, payload });
  }

  /**
   * Queue a spatially-scoped event: on flush, every listener for `event`
   * fires once per entity within `radius` tiles (Chebyshev) of (x, y),
   * with the receiving entity's id merged into the payload. Entities
   * outside the radius never hear it — a damage event at (5000, 5000)
   * costs nothing for the population at (0, 0).
   */
  emitNear(
    x: number,
    y: number,
    radius: number,
    event: string,
    payload: unknown,
    world: string = OVERWORLD,
  ): void {
    this.spatialQueue.push({ event, payload, x, y, radius, world });
  }

  /** Deliver every queued event to its listeners, in queue order. */
  flush(): void {
    let iterations = 0;
    while (this.queue.length > 0) {
      if (++iterations > MAX_FLUSH_ITERATIONS) {
        console.error(
          `[events] flush exceeded ${MAX_FLUSH_ITERATIONS} iterations - dropping queued events ` +
            '(a listener is probably re-emitting forever)',
        );
        this.queue.length = 0;
        break;
      }
      const next = this.queue.shift();
      if (!next) continue;
      for (const listener of this.listeners.get(next.event) ?? []) {
        listener(next.payload);
      }
    }
  }

  /**
   * Deliver every queued spatial event once per nearby entity. Unlike
   * flush(), delivery is per receiver, not per emit: each entity within
   * the event's radius gets the payload with its own id attached (see
   * withReceiverId), so per-entity reactions can key on it without every
   * listener scanning the whole world. A throwing listener is isolated
   * per delivery.
   */
  flushSpatial(world: World): void {
    let iterations = 0;
    while (this.spatialQueue.length > 0) {
      if (++iterations > MAX_FLUSH_ITERATIONS) {
        console.error(
          `[events] spatial flush exceeded ${MAX_FLUSH_ITERATIONS} iterations - dropping queued events ` +
            '(a listener is probably re-emitting forever)',
        );
        this.spatialQueue.length = 0;
        break;
      }
      const next = this.spatialQueue.shift();
      if (!next) continue;
      const listeners = this.listeners.get(next.event);
      if (!listeners || listeners.length === 0) continue;
      const nearbyIds = world.entityIdsInRadius(next.x, next.y, next.radius, next.world);
      for (const entityId of nearbyIds) {
        const entity = world.get(entityId);
        if (!entity) continue;
        for (const listener of listeners) {
          try {
            listener(withReceiverId(next.payload, entityId));
          } catch (err) {
            console.error(`[events] spatial listener for "${next.event}" threw:`, err);
          }
        }
      }
    }
  }
}
