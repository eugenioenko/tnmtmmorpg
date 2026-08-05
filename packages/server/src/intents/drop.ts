import type { DropIntent } from '@game/shared';
import { dropItem, type InventoryContext } from '../systems/inventory.ts';
import { isInteger } from './util.ts';

/**
 * Apply a 'drop' intent: drop the item in `slot` onto the ground in front
 * of the player (the inventory system handles the details).
 */
export function handleDropIntent(
  ctx: InventoryContext | undefined,
  entityId: number,
  intent: DropIntent,
): void {
  if (!ctx) {
    console.warn(`[tick] entity ${entityId} drop: no inventory system — rejected`);
    return;
  }
  const slot = intent.slot;
  if (!isInteger(slot)) {
    console.warn(`[tick] entity ${entityId} drop: slot must be an integer — rejected`);
    return;
  }
  if (dropItem(ctx, entityId, slot) <= 0) {
    console.warn(`[tick] entity ${entityId} drop: slot ${slot} has nothing droppable — rejected`);
  }
}
