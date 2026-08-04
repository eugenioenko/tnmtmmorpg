/**
 * Safety valve: if a listener keeps re-emitting forever, stop flushing so
 * the tick loop cannot be wedged by a runaway handler.
 */
const MAX_FLUSH_ITERATIONS = 1000;

type Listener = (payload: unknown) => void;

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

  on(event: string, listener: Listener): void {
    const list = this.listeners.get(event);
    if (list) list.push(listener);
    else this.listeners.set(event, [listener]);
  }

  /** Queue an event; it is delivered on the next flush. */
  emit(event: string, payload: unknown): void {
    this.queue.push({ event, payload });
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
}
