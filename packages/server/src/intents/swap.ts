import type { SwapIntent } from '@game/shared';
import { swapSlots, type InventoryContext } from '../systems/inventory.ts';
import { isInteger } from './util.ts';

/**
 * Apply a 'swap' intent: exchange two of the player's own inventory slots
 * (the inventory system validates both slots).
 */
export function handleSwapIntent(
  ctx: InventoryContext | undefined,
  entityId: number,
  intent: SwapIntent,
): void {
  if (!ctx) {
    console.warn(`[tick] entity ${entityId} swap: no inventory system — rejected`);
    return;
  }
  const a = intent.a;
  const b = intent.b;
  if (!isInteger(a) || !isInteger(b)) {
    console.warn(`[tick] entity ${entityId} swap: slots must be integers — rejected`);
    return;
  }
  if (!swapSlots(ctx, entityId, a, b)) {
    console.warn(`[tick] entity ${entityId} swap: slots ${a}/${b} cannot be swapped — rejected`);
  }
}
