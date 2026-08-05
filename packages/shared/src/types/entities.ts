export type WorldCoord = { x: number; y: number };

export type Direction = 'n' | 's' | 'e' | 'w';

export interface EntityState {
  id: number;
  kind: string;
  x: number;
  y: number;
  components: Record<string, unknown>;
}

export interface TileState {
  x: number;
  y: number;
  kind: string; // one of the 8 terrain kinds from terrain.ts
}

// ── Phase 7: combat events ─────────────────────────────────────────────────

/** Emitted when any entity takes damage. */
export interface DamageEvent {
  targetId: number;
  /** Attacker, or 0 for environment. */
  sourceId: number;
  /** Final damage after defense reduction. */
  amount: number;
  /** Damage before defense reduction. */
  rawAmount: number;
  /** 'physical' | 'fire' | 'poison' etc. — future proofing for elements. */
  element?: string;
}

/**
 * Emitted when an entity dies. Core despawns the entity right after emitting;
 * features listen to award loot, spawn graves, etc.
 */
export interface DeathEvent {
  entityId: number;
  /** Killer, or 0 for environmental death. */
  killerId?: number;
}
