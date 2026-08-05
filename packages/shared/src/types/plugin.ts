import type { EntityState, WorldCoord } from './entities.ts';
import type { ItemDef, RecipeDef } from './items.ts';

/**
 * The version of the feature API contract (definePlugin/defineClient shapes,
 * the WorldAPI surface, the intent and message envelope). Bump it when the
 * contract changes in a breaking way — a deliberate, announced act, never an
 * incidental one. Features are written against a specific version; core
 * guards or migrates when the number moves.
 */
export const FEATURE_API_VERSION = 1;

// ── Phase 4: feature plugin system ─────────────────────────────────────────

/**
 * The sanctioned world API — the ONLY mutation surface feature code gets.
 * Core internals (the World class, the entity store, persistence) are never
 * exposed to features; everything a feature can do goes through this.
 */
export interface WorldAPI {
  /** Spawn an entity of `kind` at a position; returns its id. */
  spawn(kind: string, pos: WorldCoord, components?: Record<string, unknown>): number;
  /** A detached snapshot of an entity's state, or undefined if it is gone. */
  get(id: number): EntityState | undefined;
  despawn(id: number): void;
  /** Every entity carrying all of the named components (detached copies). */
  query(...componentNames: string[]): EntityState[];
  /** Tile kind at (x, y); out-of-bounds reads as 'water'. */
  tile(x: number, y: number): string;
  setTile(x: number, y: number, kind: string): void;
  /** Hand `count` of an item to an entity; returns how many were NOT accepted. */
  give(entityId: number, itemId: string, count: number): number;
  /** Every registered item definition carrying a tag, across all features. */
  queryItemsByTag(tag: string): ItemDef[];
  /** Phase 6: every recipe craftable at a station entity, matched by its kind. */
  getAvailableRecipes(stationEntityId: number): RecipeDef[];
  /** Queue an event for the bus; listeners fire after systems run. */
  emit(event: string, payload: unknown): void;
  /**
   * Queue a spatially-scoped event: listeners fire once per entity within
   * `radius` tiles (Chebyshev) of (x, y), with the receiving entity's id
   * merged into the payload (payload fields are preserved).
   */
  emitNear(x: number, y: number, radius: number, event: string, payload: unknown): void;
  /** Seeded, deterministic random in [0, 1). Math.random is banned by lint. */
  rng(): number;
  log: (msg: string) => void;
}

export interface SystemDef {
  /** Namespaced id, e.g. '_example:beat'. */
  name: string;
  fn: (world: WorldAPI, delta: number) => void;
}

export interface CommandDef {
  /** Namespaced id, e.g. '_example:greet'; dispatched by matching intent kind. */
  name: string;
  /**
   * `entityId` is the entity whose connection sent the intent — commands act
   * on their sender (give items, spawn a chest at the player, ...).
   */
  fn: (world: WorldAPI, args: unknown, entityId: number) => void;
}

export type EventHandler = (world: WorldAPI, payload: unknown) => void;

/**
 * Everything one feature registers. Every id except `plugin.id` itself must
 * be namespaced `feature:thing`; ids are unique across the whole world.
 */
export interface PluginAPI {
  /** The feature's name, e.g. 'farming' or '_example'. */
  id: string;
  items: ItemDef[];
  recipes: RecipeDef[];
  entityKinds: string[];
  systems: SystemDef[];
  commands: CommandDef[];
  /** Event listeners keyed by event name; several features may listen to one event. */
  events: Record<string, EventHandler>;
  /**
   * NPC behaviors. A behavior name goes into an NPC's `npc.ai` component;
   * the core NPC system looks it up here, falls back to the built-in
   * 'wander', and runs it (guarded) once per tick while the NPC is awake.
   * Optional — a feature with no NPCs simply omits it.
   */
  ais?: AIDef[];
}

/**
 * A feature-registered NPC behavior, run by the core NPC system once per
 * tick while the NPC is awake (chunks with no players nearby sleep for free).
 *
 * `entity` is the LIVE NPC entity this AI controls — NOT a detached copy.
 * Mutate its `npc` and `movement` components in place to change state and
 * request movement (set `movement.dir`; the system performs the actual
 * position change and keeps the spatial index in sync). Never set
 * `entity.x`/`entity.y` directly, and never touch other entities' live
 * state — `nearby` holds detached copies for exactly that reason.
 */
export interface AIDef {
  /** Namespaced id, e.g. '_example:wander'; referenced by `npc.ai`. */
  name: string;
  fn: (world: WorldAPI, entity: EntityState, nearby: EntityState[], tick: number) => void;
}

/**
 * Marks an object as a server feature plugin. Identity at runtime; the
 * loader validates the shape at boot and registers every registry.
 */
export function definePlugin(plugin: PluginAPI): PluginAPI {
  return plugin;
}

/**
 * Marks an object as a client feature plugin: optional item definitions
 * (names/emoji for the inventory panel), UI panels (React components) and
 * sprite glyphs (entity kind -> emoji). Identity at runtime; the client
 * loader discovers modules via import.meta.glob. The return is unknown
 * because panels are React components, which shared cannot type.
 */
export function defineClient(plugin: {
  items?: ItemDef[];
  panels?: Record<string, unknown>;
  sprites?: Record<string, string>;
}): unknown {
  return plugin;
}
