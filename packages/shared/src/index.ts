/**
 * The version of the feature API contract (definePlugin/defineClient shapes,
 * the WorldAPI surface, the intent and message envelope). Bump it when the
 * contract changes in a breaking way — a deliberate, announced act, never an
 * incidental one. Features are written against a specific version; core
 * guards or migrates when the number moves.
 */
export const FEATURE_API_VERSION = 1;

export type WorldCoord = { x: number; y: number };

export type Direction = 'n' | 's' | 'e' | 'w';

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

/**
 * Everything a client can send. Discriminated on `kind`: 'move', the Phase 5
 * inventory kinds and the Phase 6 crafting kinds are handled by core; every
 * other kind dispatches to the feature command with that namespaced id.
 */
export type Intent =
  | MoveIntent
  | DropIntent
  | PickupIntent
  | TransferIntent
  | SwapIntent
  | CraftIntent
  | CancelCraftIntent
  | CommandIntent;

export interface Snapshot {
  t: 'snapshot';
  tick: number;
  entities: EntityState[];
  tiles: TileState[];
  /** Names of feature systems the server guard auto-disabled; present only when non-empty. */
  disabledFeatures?: string[];
}

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

/** Lightweight latency probe; the server echoes `ts` back in a Pong. */
export interface Ping {
  t: 'ping';
  ts: number;
}

export interface Pong {
  t: 'pong';
  ts: number;
}

export type ClientMessage = Intent | Ping;
export type ServerMessage = Snapshot | Pong | RecipesMessage;

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
  /** Tile kind at (x, y); out-of-bounds reads as 'wall'. */
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

/** Item definition. Stub for now — refined in Phase 5. */
export interface ItemDef {
  id: string;
  name: string;
  tags: string[];
  stack: number;
}

// ── Phase 6: crafting and stations ─────────────────────────────────────────

/** One input requirement of a recipe: match by exact item id OR by tag. */
export interface RecipeInput {
  /** Match any registered item carrying this tag (the interop primitive). */
  tag?: string;
  /** OR match this exact item id. */
  id?: string;
  count: number;
}

export interface RecipeOutput {
  id: string;
  count: number;
}

/**
 * A crafting recipe. `station` is the entity kind of the station it requires
 * (e.g. 'alchemy:cauldron'); it is what the recipe browser filters on and
 * what the craft intent gates against. `ticks` is the crafting duration in
 * ticks (10 ticks per second).
 */
export interface RecipeDef {
  id: string;
  station: string;
  inputs: RecipeInput[];
  outputs: RecipeOutput[];
  ticks: number;
}

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

/**
 * The recipe registry, pushed to each client once on connect. Recipes are
 * immutable at runtime (registries are built at boot), so a single push is
 * enough; the client renders the recipe browser from it.
 */
export interface RecipesMessage {
  t: 'recipes';
  recipes: RecipeDef[];
}

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

/** All item definitions carrying a tag — the cross-feature interop primitive. */
export function itemsByTag(items: readonly ItemDef[], tag: string): ItemDef[] {
  return items.filter((item) => item.tags.includes(tag));
}
