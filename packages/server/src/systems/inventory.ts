import type { InventoryComponent, InventorySlot, ItemDef, ItemDropComponent } from '@game/shared';
import type { Entity, World } from '../world.ts';

/**
 * The core inventory system (Phase 5). Everything that moves items between
 * inventories, the ground and containers lives here; the tick loop's intent
 * handlers and the WorldAPI's give() are thin validation wrappers over these
 * functions.
 *
 * All functions mutate the live world state in place and mark affected
 * entities dirty, so the existing 50-tick flush persists every change.
 * Returns 0/false/empty-leftover when nothing could be done — callers decide
 * whether to log a rejection.
 */

export interface InventoryContext {
  world: World;
  /** Every registered item definition, keyed by id — source of stack limits. */
  items: ReadonlyMap<string, ItemDef>;
}

/** Runtime shape check — component blobs come from JSON, so never trust them. */
export function isInventory(value: unknown): value is InventoryComponent {
  if (typeof value !== 'object' || value === null) return false;
  const inv = value as Record<string, unknown>;
  return Array.isArray(inv.slots) && typeof inv.capacity === 'number';
}

function inventoryOf(entity: Entity | undefined): InventoryComponent | undefined {
  return entity && isInventory(entity.components.inventory)
    ? entity.components.inventory
    : undefined;
}

function isItemDrop(value: unknown): value is ItemDropComponent {
  if (typeof value !== 'object' || value === null) return false;
  const drop = value as Record<string, unknown>;
  return typeof drop.itemId === 'string' && typeof drop.count === 'number';
}

function groundItemAt(world: World, entity: Entity | undefined): Entity | undefined {
  if (!entity) return undefined;
  for (const candidate of world.query('itemDrop')) {
    // Same tile AND same world: an item lying at (5,5) in a cave must not be
    // pickable by someone standing at (5,5) outside it.
    if (
      candidate.kind === 'item' &&
      candidate.world === entity.world &&
      candidate.x === entity.x &&
      candidate.y === entity.y
    ) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Hand `count` of an item to an entity's inventory. Stacks onto existing
 * stacks first (up to the item's stack limit), then fills empty slots.
 * Returns how many were NOT accepted — 0 means it all fit.
 */
export function giveItem(
  ctx: InventoryContext,
  entityId: number,
  itemId: string,
  count: number,
): number {
  const entity = ctx.world.get(entityId);
  const inv = inventoryOf(entity);
  if (!inv || count <= 0) return count;
  const def = ctx.items.get(itemId);
  if (!def || def.stack < 1) return count; // unknown item: refuse everything

  const limit = def.stack;
  let remaining = count;

  // 1. Stack onto existing stacks that still have room.
  for (const slot of inv.slots) {
    if (remaining <= 0) break;
    if (slot.itemId !== itemId || slot.count <= 0 || slot.count >= limit) continue;
    const take = remaining < limit - slot.count ? remaining : limit - slot.count;
    slot.count += take;
    remaining -= take;
  }

  // 2. Fill empty slots up to the stack limit.
  for (const slot of inv.slots) {
    if (remaining <= 0) break;
    if (slot.count > 0) continue;
    const take = remaining < limit ? remaining : limit;
    slot.itemId = itemId;
    slot.count = take;
    remaining -= take;
  }

  if (remaining < count) ctx.world.markDirty(entityId);
  return remaining;
}

/**
 * Remove up to `count` from one slot; returns how many were actually removed.
 * Fully drained slots reset to { itemId: '', count: 0 }.
 */
export function removeItem(
  ctx: InventoryContext,
  entityId: number,
  slotIndex: number,
  count: number,
): number {
  const entity = ctx.world.get(entityId);
  const inv = inventoryOf(entity);
  if (!inv || count <= 0) return 0;
  const slot = inv.slots[slotIndex];
  if (!slot || slot.itemId === '' || slot.count <= 0) return 0;

  const removed = count < slot.count ? count : slot.count;
  slot.count -= removed;
  if (slot.count === 0) {
    slot.itemId = '';
    slot.count = 0;
  }
  ctx.world.markDirty(entityId);
  return removed;
}

/** True when a ground-drop entity shares the entity's tile. */
export function canPickup(ctx: InventoryContext, entityId: number): boolean {
  return groundItemAt(ctx.world, ctx.world.get(entityId)) !== undefined;
}

/**
 * Pick up the ground item at the entity's tile into its inventory. If only
 * part fits, the remainder stays on the ground; if nothing fits, the ground
 * entity is untouched. Returns true when at least one item was picked up.
 */
export function pickupItem(ctx: InventoryContext, entityId: number): boolean {
  const entity = ctx.world.get(entityId);
  const ground = groundItemAt(ctx.world, entity);
  if (!ground) return false;
  const drop = ground.components.itemDrop;
  if (!isItemDrop(drop) || drop.count <= 0) return false;

  const leftover = giveItem(ctx, entityId, drop.itemId, drop.count);
  const taken = drop.count - leftover;
  if (taken <= 0) return false; // inventory rejected everything: item stays put

  if (leftover > 0) {
    drop.count = leftover; // partial pickup: remainder stays on the ground
    ctx.world.markDirty(ground.id);
  } else {
    ctx.world.despawn(ground.id);
  }
  return true;
}

/**
 * Drop the contents of one inventory slot onto the ground at the entity's
 * tile. Dropping onto a ground stack of the same item merges up to the stack
 * limit (the excess stays in the slot); dropping onto a ground stack of a
 * different item is rejected. Returns how many items were dropped (0 =
 * nothing dropped).
 */
export function dropItem(ctx: InventoryContext, entityId: number, slotIndex: number): number {
  const entity = ctx.world.get(entityId);
  if (!entity) return 0;
  const inv = inventoryOf(entity);
  if (!inv) return 0;
  const slot = inv.slots[slotIndex];
  if (!slot || slot.itemId === '' || slot.count <= 0) return 0;

  const itemId = slot.itemId;
  const count = slot.count;
  // Unknown items (e.g. a feature removed after a save) still drop; they
  // just never merge into an unlimited-size ground stack.
  const limit = ctx.items.get(itemId)?.stack ?? Number.MAX_SAFE_INTEGER;

  const existing = groundItemAt(ctx.world, entity);
  if (existing) {
    const drop = existing.components.itemDrop;
    if (!isItemDrop(drop) || drop.itemId !== itemId) return 0; // tile holds a different item
    const room = limit - drop.count;
    if (room <= 0) return 0; // ground stack already full
    const moved = count < room ? count : room;
    drop.count += moved;
    if (moved >= count) {
      slot.itemId = '';
      slot.count = 0;
    } else {
      slot.count = count - moved;
    }
    ctx.world.markDirty(existing.id);
    ctx.world.markDirty(entityId);
    return moved;
  }

  ctx.world.spawn(
    'item',
    { x: entity.x, y: entity.y },
    { itemDrop: { itemId, count } },
    entity.world,
  );
  slot.itemId = '';
  slot.count = 0;
  ctx.world.markDirty(entityId);
  return count;
}

/**
 * Move a slot's contents from one entity's inventory into another's. Items
 * that do not fit stay in the source slot. Returns true when anything moved.
 */
export function transferItem(
  ctx: InventoryContext,
  fromEntityId: number,
  fromSlotIndex: number,
  toEntityId: number,
): boolean {
  const fromEntity = ctx.world.get(fromEntityId);
  const fromInv = inventoryOf(fromEntity);
  const fromSlot = fromInv?.slots[fromSlotIndex];
  if (!fromSlot || fromSlot.itemId === '' || fromSlot.count <= 0) return false;

  const leftover = giveItem(ctx, toEntityId, fromSlot.itemId, fromSlot.count);
  const moved = fromSlot.count - leftover;
  if (moved <= 0) return false;
  removeItem(ctx, fromEntityId, fromSlotIndex, moved);
  return true;
}

/** Exchange the contents of two slots of one inventory (drag-and-drop). */
export function swapSlots(ctx: InventoryContext, entityId: number, a: number, b: number): boolean {
  const entity = ctx.world.get(entityId);
  const inv = inventoryOf(entity);
  if (!inv || a === b) return false;
  const slotA = inv.slots[a] as InventorySlot | undefined;
  const slotB = inv.slots[b] as InventorySlot | undefined;
  if (!slotA || !slotB) return false;

  const tmpItemId = slotA.itemId;
  const tmpCount = slotA.count;
  slotA.itemId = slotB.itemId;
  slotA.count = slotB.count;
  slotB.itemId = tmpItemId;
  slotB.count = tmpCount;
  ctx.world.markDirty(entityId);
  return true;
}
