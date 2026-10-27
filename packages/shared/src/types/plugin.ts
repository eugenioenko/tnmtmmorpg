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
  /** World dimensions in tiles; the centre ((width/2, height/2)) is where players spawn. */
  readonly width: number;
  readonly height: number;
  /**
   * Persistent kv flag: without a value, returns the stored string (or
   * undefined when never set); with a value, stores it and returns the
   * previous one. Writes land in the database immediately, so flags survive
   * restarts. The standard pattern for one-time bootstrap work is
   * `if (world.getSet('feature:done', '1')) return;` — the flag is checked
   * and claimed in one call.
   */
  getSet(key: string, value?: string): string | undefined;
  /** Spawn an entity of `kind` at a position; returns its id. */
  spawn(
    kind: string,
    pos: WorldCoord,
    components?: Record<string, unknown>,
    world?: string,
  ): number;
  /** A detached snapshot of an entity's state, or undefined if it is gone. */
  get(id: number): EntityState | undefined;
  /**
   * Merge `patch` into an entity's components and mark it dirty.
   * Returns false if the entity does not exist.
   *
   * Shallow merge: each key of `patch` replaces the whole component of that
   * name. Read with get(), build the new component value, write it back —
   * never mutate the object get() handed you.
   *
   * The identity keys `id`, `kind`, `x`, `y` and `chunk` are ignored:
   * position changes go through movement, not component patches.
   *
   * House rule still applies — patch your OWN components. Another feature's
   * components are reachable, and writing them is a review failure.
   */
  update(entityId: number, patch: Record<string, unknown>): boolean;
  /**
   * Move an entity to (x, y). The write half of position, exactly as
   * update() is the write half of components: a feature asks, core decides.
   *
   * Core validates the landing tile against its own walkability rule, wraps
   * the coordinates around the torus world and keeps the spatial index and
   * the dirty set in sync. Returns false — and moves nothing — when the
   * entity is gone or the tile is not walkable, so a feature can never walk
   * an entity into water however wrong its own arithmetic is.
   *
   * There is no path check: (x, y) is where the entity ends up, not a route.
   * Step one tile at a time if you want walls to actually stop you.
   */
  move(entityId: number, x: number, y: number): boolean;
  /**
   * Move an entity into ANOTHER world. This is the door, the portal and the
   * trip home — the only call that changes which world an entity is in.
   *
   * Unlike move() there is no walkability check: the caller chooses the
   * arrival tile, because only it knows where the far side of its own door
   * should be. Returns false if the entity is gone or nothing mints that
   * world id.
   *
   * World ids are either declared (the overworld and the themed worlds) or
   * derived (`interior:<x>,<y>` for the room behind a door). An interior
   * does not exist until somebody travels into it, and costs nothing until
   * then.
   */
  travel(entityId: number, world: string, x: number, y: number): boolean;
  despawn(id: number): void;
  /** Every entity carrying all of the named components (detached copies). */
  query(...componentNames: string[]): EntityState[];
  /**
   * Detached copies of every entity within `radius` tiles (Chebyshev) of
   * (x, y). Backed by the spatial index, so it costs a few chunk lookups
   * instead of a scan of the whole world — reach for this instead of
   * filtering query() by distance.
   */
  queryNear(x: number, y: number, radius: number, world?: string): EntityState[];
  /**
   * True when a player entity is within `radius` tiles (Chebyshev) of
   * (x, y). Same index as queryNear but it stops at the first hit and
   * allocates nothing, which is what makes "only simulate near players"
   * affordable to check per entity per tick.
   */
  hasPlayerNear(x: number, y: number, radius: number, world?: string): boolean;
  /** Tile kind at (x, y); out-of-bounds reads as 'water'. */
  tile(x: number, y: number, world?: string): string;
  /**
   * Can an entity stand on (x, y)? The same rule move() enforces — ask
   * rather than re-deriving walkability from tile(), so a feature's idea of
   * what blocks movement can never drift from core's.
   */
  walkable(x: number, y: number, world?: string): boolean;
  setTile(x: number, y: number, kind: string, world?: string): void;
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
  emitNear(
    x: number,
    y: number,
    radius: number,
    event: string,
    payload: unknown,
    world?: string,
  ): void;
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
  /**
   * Event listeners keyed by event name; several features may listen to one
   * event. This is also how a feature plugs into an extension point another
   * feature offers — e.g. the npc feature emits 'npc:register-ais' once at
   * boot with a `register` callback in the payload, so NPC behaviours are
   * registered here rather than in a core registry.
   */
  events: Record<string, EventHandler>;
  /**
   * Called once, the first time a chunk is generated, so a feature can
   * scatter content across it (trees, ore, ruins). The world is lazily
   * generated — chunks materialise as players explore — so this fires for
   * new ground indefinitely, rather than decorating a fixed box near spawn.
   *
   * Core drains newly-generated chunks at a tick boundary, never on the
   * read path that generated them, so spawning here cannot mutate the
   * entity store while a snapshot is being built.
   *
   * `rng` is seeded from (world seed, cx, cy) and is the ONLY randomness
   * that belongs here: `world.rng()` is a single shared sequence whose
   * values depend on call order, so using it would make a chunk's contents
   * depend on the order players happened to explore in. This one is stable
   * per chunk, so a given seed always produces the same world.
   *
   * Decoration is one-shot: a generated chunk is persisted, and chunks
   * restored from the database are never re-decorated.
   */
  decorateChunk?: (world: WorldAPI, area: ChunkArea, rng: () => number) => void;
}

/**
 * The patch of new ground handed to `decorateChunk`, in WORLD tile
 * coordinates (inclusive bounds). Features iterate the bounds and never need
 * to know the chunk size — that is core's business. `cx`/`cy` identify the
 * chunk if a feature wants to key something off it.
 */
export interface ChunkArea {
  cx: number;
  cy: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * A player-facing action on an entity. The client walks the player within
 * `range` tiles (Chebyshev, default 1) and sends `{ kind: intent, targetId }`.
 * An entity may also carry an `interact` component of this shape, which
 * overrides the kind-level declaration.
 */
export interface Interaction {
  intent: string;
  /** Verb shown in prompts and tooltips, e.g. 'Enter', 'Talk'. */
  label: string;
  range?: number;
}

/**
 * What feature UI gets from the client: read-only views of the newest
 * snapshot, a way to act, and a line in the message log. Components are
 * plain React; they re-render by subscribing to snapshots.
 */
export interface ClientAPI {
  localPlayer(): EntityState | undefined;
  entity(id: number): EntityState | undefined;
  itemDef(id: string): ItemDef | undefined;
  itemIcon(id: string): string;
  /** Called after every snapshot; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  sendIntent(intent: { t: 'intent'; kind: string; [key: string]: unknown }): void;
  notify(text: string, tone?: 'info' | 'good' | 'bad' | 'loot' | 'quest' | 'level'): void;
  /** Open or close one of the HUD windows by id. */
  toggleWindow(id: string, open?: boolean): void;
  /** A large centred announcement that fades by itself. */
  banner(text: string, sub?: string, kind?: 'level' | 'death' | 'info'): void;
}

export interface ClientWindow {
  title: string;
  /** Emoji or short glyph for the action-bar button. */
  icon: string;
  /** KeyboardEvent.code that toggles it, e.g. 'KeyC'. */
  hotkey?: string;
  /** React component receiving `{ client }`. */
  component: unknown;
  /** Lower sorts first on the action bar. */
  order?: number;
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
  /** Developer panels, shown in the debug drawer (F3). */
  panels?: Record<string, unknown>;
  sprites?: Record<string, string>;
  /** Entity kind -> what clicking it or pressing Space beside it does. */
  interactions?: Record<string, Interaction>;
  /** Player-facing windows, framed by the HUD and listed on the action bar. */
  windows?: Record<string, ClientWindow>;
  /** Always-on HUD widgets; each receives `{ client }`. */
  hud?: Record<string, unknown>;
}): unknown {
  return plugin;
}
