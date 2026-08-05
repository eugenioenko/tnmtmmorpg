import type { Direction } from './entities.ts';

// ── Phase 5: items and inventory ───────────────────────────────────────────

/** One cell of an inventory; empty cells are { itemId: '', count: 0 }. */
export interface InventorySlot {
  itemId: string;
  count: number;
}

/** Carried items: a fixed-size slot array plus its capacity. */
export interface InventoryComponent {
  slots: InventorySlot[];
  capacity: number;
}

/** Ground drops (kind 'item' entities): what lies on the floor. */
export interface ItemDropComponent {
  itemId: string;
  count: number;
}

/** Default inventory capacity for players and containers. */
export const INVENTORY_CAPACITY = 20;

/** A fresh, empty fixed-size slot array for an inventory. */
export function emptySlots(capacity: number): InventorySlot[] {
  return Array.from({ length: capacity }, () => ({ itemId: '', count: 0 }));
}

// ── NPCs ────────────────────────────────────────────────────────────────────

/**
 * The NPC brain component, carried by every entity of kind 'npc'. `ai` names
 * the behavior: 'wander' is the core built-in; a feature-registered behavior
 * is referenced by its namespaced id (e.g. '_example:wander'). `state` is
 * the behavior's own business — the core system only reads what it needs
 * and never dictates states.
 */
export interface NPCComponent {
  /** Behavior name: 'wander' (core) or a feature-registered namespaced id. */
  ai: string;
  /** 'idle' | 'wandering' | 'chasing' | 'fleeing' — set by the AI behavior. */
  state: string;
  /** Entity id the behavior is chasing/fleeing, when any. */
  target?: number;
  /** Tick of the NPC's last acted-upon decision; timers are tick-based. */
  lastActionTick: number;
  /** 'cx,cy' chunk this NPC belongs to; wander behaviors stay near it. */
  spawnChunk?: string;
}

/**
 * Best-effort movement, driven by the core NPC system: every
 * `1 / speed` ticks (rounded) it steps one tile in `dir` when walkable.
 * `speed` 0.2 means one tile every 5 ticks. The AI only sets `dir`; the
 * system performs the actual position change.
 */
export interface MovementComponent {
  /** Tiles per tick, fractional (0.2 = one tile every 5 ticks). */
  speed: number;
  /** Direction of the next move, or unset when standing still. */
  dir?: Direction;
  /** Absolute tick when the next move happens. */
  nextMoveTick: number;
}

// ── Phase 6: crafting and stations ─────────────────────────────────────────

/** One in-progress (or queued) craft at a station. */
export interface CraftingJob {
  recipeId: string;
  stationEntityId: number;
  crafterEntityId: number;
  /** Ticks elapsed so far. */
  progress: number;
  totalTicks: number;
  /**
   * The exact items consumed when the craft started. Cancellation refunds
   * precisely these — a tag input may have consumed a different feature's
   * item, so the recipe alone cannot describe the refund.
   */
  consumed: { itemId: string; count: number }[];
}

/**
 * A station's crafting state. A station runs one ACTIVE job per crafter in
 * parallel (two players crafting at the same station both progress every
 * tick); a crafter's extra crafts queue behind their own active job.
 */
export interface CraftingComponent {
  activeJobs: CraftingJob[];
  queue: CraftingJob[];
}

// ── Phase 7: combat ─────────────────────────────────────────────────────────

/**
 * Stats every combat-capable entity has (players, NPCs, future monsters).
 * hp/maxHp drive the client's health bar and death; atk/def feed the core
 * damage formula; `level` is metadata for future scaling features.
 */
export interface StatsComponent {
  hp: number;
  maxHp: number;
  atk: number; // base attack
  def: number; // base defense
  level: number;
}
