import type { EntityState, TileState } from './entities.ts';
import type { Intent } from './intents.ts';
import type { RecipeDef } from './items.ts';

/** Sent once on connect so the client can identify its own entity. */
/**
 * The client telling the server where its camera is pointed, in world tiles.
 *
 * The camera is not welded to the player — it trails on a rubber band and can
 * be panned with free-look — so the tiles the client RENDERS are not
 * necessarily the tiles centred on the player. The server centres each
 * snapshot here instead, clamped to MAX_VIEW_OFFSET tiles from the player so
 * a forged client cannot scout the map from safety.
 */
export interface ViewMessage {
  t: 'view';
  x: number;
  y: number;
}

export interface WelcomeMessage {
  t: 'welcome';
  entityId: number;
  color: string;
  /**
   * How much world this server will send, in tiles either side of the
   * player. The server is authoritative about this: the client caps its
   * canvas so it never renders ground it was not sent. Clients may resize
   * freely below the cap. Absent from an older server, in which case the
   * client falls back to the shared defaults.
   */
  viewRadiusX?: number;
  viewRadiusY?: number;
  /** Tile edge in pixels, so the client converts the radii to a pixel cap. */
  tileSize?: number;
}

/**
 * A complete view of the world: every entity and every non-grass tile in the
 * receiving player's view radius. Sent when a session first connects and
 * every 300 ticks (30s at 10Hz) afterwards to resync the client's
 * accumulated state.
 */
export interface FullSnapshot {
  /**
   * Which world this snapshot describes. The client keys its palette off it,
   * and treats a change as "everything you knew is stale". Absent means the
   * overworld, so an older server still makes sense.
   */
  world?: string;
  t: 'full';
  tick: number;
  entities: EntityState[];
  /**
   * Sparse tile map: only tiles whose kind differs from the world default
   * ('grass') within the receiving player's view radius. Any coordinate not
   * listed here is grass.
   */
  tiles: TileState[];
  /** Player's own position (always included, for the camera). */
  playerX: number;
  playerY: number;
  /** Names of feature systems the server guard auto-disabled; present only when non-empty. */
  disabledFeatures?: string[];
}

/**
 * Everything that changed for this session since the previous snapshot.
 * Entities are included wholesale (there are typically 1-20 per viewport and
 * they move every tick); tiles are the delta win — a 60x40 viewport would
 * otherwise resend ~2400 mostly-unchanged tiles per tick. The client applies
 * this on top of its accumulated state.
 */
export interface DeltaSnapshot {
  /**
   * Which world this snapshot describes. The client keys its palette off it,
   * and treats a change as "everything you knew is stale". Absent means the
   * overworld, so an older server still makes sense.
   */
  world?: string;
  t: 'delta';
  tick: number;
  /** Entities that entered or changed in viewport since last snapshot. */
  entities: EntityState[];
  /** Entity IDs that left the viewport. */
  removedEntities: number[];
  /** Tiles that changed since last snapshot (newly visible or changed). */
  tiles: TileState[];
  /** Tiles that left the viewport (these revert to default/grass on client). */
  removedTiles: { x: number; y: number }[];
  /** Player's own position (always included, for the camera). */
  playerX: number;
  playerY: number;
  /** Names of feature systems the server guard auto-disabled; present only when non-empty. */
  disabledFeatures?: string[];
}

/** Lightweight latency probe; the server echoes `ts` back in a Pong. */
export interface Ping {
  t: 'ping';
  ts: number;
}

export interface Pong {
  t: 'pong';
  ts: number;
}

/**
 * The recipe registry, pushed to each client once on connect. Recipes are
 * immutable at runtime (registries are built at boot), so a single push is
 * enough; the client renders the recipe browser from it.
 */
export interface RecipesMessage {
  t: 'recipes';
  recipes: RecipeDef[];
}

export type ClientMessage = Intent | Ping;
export type ServerMessage = WelcomeMessage | FullSnapshot | DeltaSnapshot | Pong | RecipesMessage;
