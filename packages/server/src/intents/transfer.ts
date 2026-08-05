import type { TransferIntent } from '@game/shared';
import { isInventory, transferItem, type InventoryContext } from '../systems/inventory.ts';
import { isInteger } from './util.ts';

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
 * Apply a 'transfer' intent: move an item between the player's inventory
 * and an adjacent container, in either direction.
 */
export function handleTransferIntent(
  ctx: InventoryContext | undefined,
  entityId: number,
  intent: TransferIntent,
): void {
  if (!ctx) {
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
  handleTransfer(ctx, entityId, containerId, fromSlot, dir);
}
