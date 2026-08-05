import { pickupItem, type InventoryContext } from '../systems/inventory.ts';

/**
 * Apply a 'pickup' intent: pick up everything lying on the player's own
 * tile (the inventory system handles the details). The intent carries no
 * payload, so the handler only receives the context and the sender.
 */
export function handlePickupIntent(
  ctx: InventoryContext | undefined,
  entityId: number,
): void {
  if (!ctx) {
    console.warn(`[tick] entity ${entityId} pickup: no inventory system — rejected`);
    return;
  }
  if (!pickupItem(ctx, entityId)) {
    console.warn(`[tick] entity ${entityId} pickup: nothing to pick up here — rejected`);
  }
}
