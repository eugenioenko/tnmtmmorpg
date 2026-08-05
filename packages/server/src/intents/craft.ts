import type { CancelCraftIntent, CraftIntent } from '@game/shared';
import { cancelCraft, startCraft, type CraftingContext } from '../systems/crafting.ts';
import { isInteger } from './util.ts';

/**
 * Apply a 'craft' intent: start crafting `recipeId` at the station entity
 * (the crafting system validates inputs, capacity and adjacency).
 */
export function handleCraftIntent(
  ctx: CraftingContext | undefined,
  entityId: number,
  intent: CraftIntent,
): void {
  if (!ctx) {
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
  const result = startCraft(ctx, entityId, stationEntityId, recipeId);
  if (!result.ok) {
    console.warn(`[tick] entity ${entityId} craft '${recipeId}' rejected: ${result.reason}`);
  }
}

/**
 * Apply a 'cancelCraft' intent: cancel one of the crafter's own jobs at the
 * station, refunding exactly the items the craft consumed.
 */
export function handleCancelCraftIntent(
  ctx: CraftingContext | undefined,
  entityId: number,
  intent: CancelCraftIntent,
): void {
  if (!ctx) {
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
  const result = cancelCraft(ctx, entityId, stationEntityId, jobIndex);
  if (!result.ok) {
    console.warn(
      `[tick] entity ${entityId} cancelCraft at station ${stationEntityId} rejected: ${result.reason}`,
    );
  }
}
