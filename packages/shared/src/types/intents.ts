import type { Direction } from './entities.ts';

/** Common envelope of every intent; `kind` is the discriminant. */
export interface BaseIntent {
  t: 'intent';
}

export interface MoveIntent extends BaseIntent {
  kind: 'move';
  dir: Direction;
}

export interface DropIntent extends BaseIntent {
  kind: 'drop';
  /** Inventory slot (of the sending player) to drop from. */
  slot: number;
}

export interface PickupIntent extends BaseIntent {
  kind: 'pickup';
}

export interface TransferIntent extends BaseIntent {
  kind: 'transfer';
  /** 'in' moves a player slot into the container; 'out' moves a container slot to the player. */
  dir: 'in' | 'out';
  /** Slot in the source inventory ('in': the player's; 'out': the container's). */
  fromSlot: number;
  /** The container entity the transfer involves. */
  toContainerId: number;
}

export interface SwapIntent extends BaseIntent {
  kind: 'swap';
  /** The two inventory slots (of the sending player) to exchange. */
  a: number;
  b: number;
}

/**
 * Any other intent kind — a feature command (e.g. '_example:give'). Args are
 * every field besides t and kind; the index signature lets features carry
 * free-form payloads without touching shared types.
 */
export interface CommandIntent extends BaseIntent {
  kind: string;
  [key: string]: unknown;
}

export interface CraftIntent extends BaseIntent {
  kind: 'craft';
  recipeId: string;
  stationEntityId: number;
}

export interface CancelCraftIntent extends BaseIntent {
  kind: 'cancelCraft';
  /**
   * Index among the crafter's OWN jobs at the station: 0 is their active job
   * (if any), then their queued jobs in order.
   */
  jobIndex: number;
  stationEntityId: number;
}

/** Phase 7: melee attack intent — hit `targetId` if adjacent. */
export interface AttackIntent extends BaseIntent {
  kind: 'attack';
  targetId: number;
}

/**
 * Everything a client can send. Discriminated on `kind`: 'move', the Phase 5
 * inventory kinds, the Phase 6 crafting kinds and the Phase 7 'attack' kind
 * are handled by core; every other kind dispatches to the feature command
 * with that namespaced id.
 */
export type Intent =
  | MoveIntent
  | DropIntent
  | PickupIntent
  | TransferIntent
  | SwapIntent
  | CraftIntent
  | CancelCraftIntent
  | AttackIntent
  | CommandIntent;
