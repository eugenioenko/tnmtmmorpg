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
  kind: string; // 'grass' | 'wall'
}

// ── Binary protocol: tile kind bytes ───────────────────────────────────────

/**
 * Tile kind string -> wire byte for the compact binary snapshot format
 * (binary.ts). Byte 255 is reserved there as an escape for kinds not listed
 * here, so the table can grow without a wire-format change.
 */
export const TILE_KIND_BYTE: Record<string, number> = {
  grass: 0,
  wall: 1,
};

/** Wire byte -> tile kind string; the inverse of TILE_KIND_BYTE. */
export const TILE_KIND_BY_BYTE: Record<number, string> = {
  0: 'grass',
  1: 'wall',
};

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
