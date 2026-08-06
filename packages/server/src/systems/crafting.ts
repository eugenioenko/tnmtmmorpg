import type {
  CraftingComponent,
  CraftingJob,
  InventoryComponent,
  ItemDef,
  RecipeDef,
  RecipeInput,
  WorldCoord,
} from '@game/shared';
import { OVERWORLD } from '@game/shared';
import type { Entity, World } from '../world.ts';
import { giveItem, isInventory, removeItem } from './inventory.ts';

/**
 * The core crafting runtime (Phase 6).
 *
 * Stations are ordinary entities whose `kind` is the station type (e.g.
 * '_example:workbench'); recipes declare the station kind they require, and
 * the craft intent is validated against it. Crafting state lives in the
 * station's `crafting` component: `activeJobs` (one per crafter, progressing
 * in parallel) plus a per-crafter `queue` for extra crafts.
 *
 * Design decisions:
 * - Inputs are consumed atomically at craft start (a full plan is built and
 *   only then applied), and the exact items taken are recorded on the job.
 *   Cancellation refunds precisely those items — a `{ tag: 'herb' }` input
 *   may have consumed another feature's item, and the refund must give back
 *   exactly that item: no dupes, no losses.
 * - Items that cannot fit anywhere (a full inventory on completion or
 *   cancellation) are dropped on the ground rather than destroyed.
 * - Jobs survive server restarts: the whole component lives inside the
 *   entity's persisted data blob, so progress resumes where it left off.
 *
 * The runtime itself is core and runs directly in the tick (see
 * server/src/index.ts runSystems): feature systems only ever see the
 * WorldAPI, whose copies are detached, and the crafting loop must run even
 * when FEATURES env selects no crafting feature. Feature systems observe the
 * results (jobs, outputs) via snapshots and events.
 */

export interface CraftingContext {
  world: World;
  /** Every registered item definition, keyed by id — source of tag matches. */
  items: ReadonlyMap<string, ItemDef>;
  /** Every registered recipe definition, keyed by id. */
  recipes: ReadonlyMap<string, RecipeDef>;
}

export type CraftFailure =
  | 'no_crafter'
  | 'no_station'
  | 'no_recipe'
  | 'wrong_station'
  | 'too_far'
  | 'no_inventory'
  | 'missing_inputs'
  | 'no_job'
  | 'not_your_job';

export type CraftResult = { ok: true } | { ok: false; reason: CraftFailure };

function fail(reason: CraftFailure): CraftResult {
  return { ok: false, reason };
}

/** Runtime shape check — component blobs come from JSON, so never trust them. */
export function isCrafting(value: unknown): value is CraftingComponent {
  if (typeof value !== 'object' || value === null) return false;
  const crafting = value as Record<string, unknown>;
  return Array.isArray(crafting.activeJobs) && Array.isArray(crafting.queue);
}

function craftingOf(entity: Entity | undefined): CraftingComponent | undefined {
  return entity && isCrafting(entity.components.crafting) ? entity.components.crafting : undefined;
}

/** Recipes craftable at a station entity: matched by the station's entity kind. */
export function getAvailableRecipes(ctx: CraftingContext, stationEntityId: number): RecipeDef[] {
  const station = ctx.world.get(stationEntityId);
  if (!station) return [];
  return [...ctx.recipes.values()].filter((recipe) => recipe.station === station.kind);
}

/** Chebyshev distance: stations are used from an adjacent tile (like containers). */
function adjacent(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  const dx = a.x > b.x ? a.x - b.x : b.x - a.x;
  const dy = a.y > b.y ? a.y - b.y : b.y - a.y;
  return dx <= 1 && dy <= 1;
}

interface Removal {
  slotIndex: number;
  amount: number;
}

/**
 * Plan (without touching anything) how to take `count` of every input out of
 * the crafter's inventory. Each input matches by exact id OR by tag; a tag
 * matches any registered item carrying it, across every feature — the interop
 * primitive. Returns the removal plan, or null when an input cannot be fully
 * satisfied. Crafting is atomic: the plan is applied only when every input
 * fits, so a rejected craft never consumes anything.
 */
function planRemovals(
  ctx: CraftingContext,
  inv: InventoryComponent,
  inputs: RecipeInput[],
): Removal[] | null {
  const plan: Removal[] = [];
  for (const input of inputs) {
    const tag = input.tag;
    const id = input.id;
    if (tag === undefined && id === undefined) return null; // unsatisfiable input
    let need = input.count;
    for (let i = 0; i < inv.slots.length && need > 0; i++) {
      const slot = inv.slots[i];
      if (slot.count <= 0) continue;
      const matches =
        id !== undefined
          ? slot.itemId === id
          : (ctx.items.get(slot.itemId)?.tags.includes(tag ?? '') ?? false);
      if (!matches) continue;
      const take = need < slot.count ? need : slot.count;
      plan.push({ slotIndex: i, amount: take });
      need -= take;
    }
    if (need > 0) return null;
  }
  return plan;
}

/** Apply a plan; returns the exact items taken, aggregated by item id. */
function applyRemovals(
  ctx: CraftingContext,
  crafterEntityId: number,
  inv: InventoryComponent,
  plan: Removal[],
): { itemId: string; count: number }[] {
  const consumed = new Map<string, number>();
  for (const { slotIndex, amount } of plan) {
    const itemId = inv.slots[slotIndex]?.itemId ?? '';
    if (itemId === '') continue;
    removeItem(ctx, crafterEntityId, slotIndex, amount);
    consumed.set(itemId, (consumed.get(itemId) ?? 0) + amount);
  }
  return [...consumed.entries()].map(([itemId, count]) => ({ itemId, count }));
}

/**
 * Hand items to an entity; whatever does not fit is dropped on the ground at
 * the nearest free tile. Completion and cancellation never lose items.
 */
function giveOrDrop(
  ctx: CraftingContext,
  entityId: number,
  itemId: string,
  count: number,
  fallbackPos: WorldCoord,
): void {
  const leftover = giveItem(ctx, entityId, itemId, count);
  if (leftover > 0) {
    // Drop into the crafter's own world, not the overworld by default.
    const inWorld = ctx.world.get(entityId)?.world ?? OVERWORLD;
    const tile = freeDropTile(ctx, fallbackPos, inWorld);
    ctx.world.spawn('item', tile, { itemDrop: { itemId, count: leftover } }, inWorld);
    console.warn(
      `[crafting] ${leftover}x '${itemId}' did not fit entity ${entityId} - dropped at (${tile.x}, ${tile.y})`,
    );
  }
}

/** The nearest tile to `pos` that holds no ground item entity. */
function freeDropTile(ctx: CraftingContext, pos: WorldCoord, inWorld: string): WorldCoord {
  // Occupancy is per-world: a drop at (5,5) in a cave does not block (5,5)
  // in the overworld.
  const occupied = new Set(
    ctx.world
      .query('itemDrop')
      .filter((e) => e.world === inWorld)
      .map((e) => `${e.x},${e.y}`),
  );
  const candidates: WorldCoord[] = [
    pos,
    { x: pos.x + 1, y: pos.y },
    { x: pos.x - 1, y: pos.y },
    { x: pos.x, y: pos.y + 1 },
    { x: pos.x, y: pos.y - 1 },
  ];
  for (const tile of candidates) {
    if (ctx.world.isWalkable(tile.x, tile.y, inWorld) && !occupied.has(`${tile.x},${tile.y}`)) {
      return tile;
    }
  }
  return pos; // everything is full: fall back to the player's own tile
}

/**
 * Validate and start a craft:
 *  - the station entity exists and its kind matches the recipe's station
 *  - the crafter is adjacent to the station
 *  - the crafter's inventory holds every input (by id or tag)
 * Consumes the inputs, then adds the job to the station's crafting component
 * (creating it when missing). If the crafter already has an active job at
 * this station, the new job is queued behind it — per-player queue.
 */
export function startCraft(
  ctx: CraftingContext,
  crafterEntityId: number,
  stationEntityId: number,
  recipeId: string,
): CraftResult {
  const station = ctx.world.get(stationEntityId);
  if (!station) return fail('no_station');
  const recipe = ctx.recipes.get(recipeId);
  if (!recipe) return fail('no_recipe');
  if (recipe.station !== station.kind) return fail('wrong_station');
  const crafter = ctx.world.get(crafterEntityId);
  if (!crafter) return fail('no_crafter');
  if (!adjacent(crafter, station)) return fail('too_far');
  if (!isInventory(crafter.components.inventory)) return fail('no_inventory');
  const inv = crafter.components.inventory;

  const plan = planRemovals(ctx, inv, recipe.inputs);
  if (!plan) return fail('missing_inputs');
  const consumed = applyRemovals(ctx, crafterEntityId, inv, plan);

  let crafting = craftingOf(station);
  if (!crafting) {
    crafting = { activeJobs: [], queue: [] };
    station.components.crafting = crafting;
  }

  const job: CraftingJob = {
    recipeId,
    stationEntityId,
    crafterEntityId,
    progress: 0,
    totalTicks: recipe.ticks,
    consumed,
  };

  // One active slot per crafter per station; extra crafts queue behind it.
  const queued = crafting.activeJobs.some((j) => j.crafterEntityId === crafterEntityId);
  if (queued) crafting.queue.push(job);
  else crafting.activeJobs.push(job);

  ctx.world.markDirty(stationEntityId);
  console.log(
    `[crafting] entity ${crafterEntityId} started '${recipeId}' at station ${stationEntityId}` +
      ` (${recipe.ticks} ticks${queued ? ', queued behind their active job' : ''})`,
  );
  return { ok: true };
}

/** Deliver a finished job's outputs, refunding inputs if the recipe vanished. */
function completeJob(ctx: CraftingContext, station: Entity, job: CraftingJob): void {
  const recipe = ctx.recipes.get(job.recipeId);
  const crafter = ctx.world.get(job.crafterEntityId);
  const dropPos: WorldCoord = crafter
    ? { x: crafter.x, y: crafter.y }
    : { x: station.x, y: station.y };

  if (!recipe) {
    // The recipe's feature was disabled after the craft started: hand the
    // committed inputs back so nothing is lost.
    console.warn(
      `[crafting] '${job.recipeId}' no longer registered - refunding its inputs to entity ${job.crafterEntityId}`,
    );
    for (const input of job.consumed) {
      giveOrDrop(ctx, job.crafterEntityId, input.itemId, input.count, dropPos);
    }
    return;
  }

  console.log(
    `[crafting] '${job.recipeId}' complete for entity ${job.crafterEntityId} at station ${station.id}` +
      recipe.outputs.map((o) => ` -> ${o.count}x ${o.id}`).join(''),
  );
  for (const output of recipe.outputs) {
    giveOrDrop(ctx, job.crafterEntityId, output.id, output.count, dropPos);
  }
}

/**
 * The per-tick crafting system (core): advance every active job at every
 * station, deliver outputs on completion, and promote the crafter's next
 * queued job into the freed active slot. Runs every tick before feature
 * systems, so feature systems observe finished crafts in the same tick.
 */
export function tickCrafting(ctx: CraftingContext): void {
  for (const station of ctx.world.query('crafting')) {
    const crafting = craftingOf(station);
    if (!crafting) continue;
    let changed = false;

    const finished: CraftingJob[] = [];
    for (const job of crafting.activeJobs) {
      job.progress++;
      changed = true;
      if (job.progress >= job.totalTicks) {
        finished.push(job);
      } else if (job.progress % 10 === 0) {
        console.log(
          `[crafting] '${job.recipeId}' at station ${station.id}: ${job.progress}/${job.totalTicks} ticks`,
        );
      }
    }

    for (const job of finished) {
      completeJob(ctx, station, job);
      const index = crafting.activeJobs.indexOf(job);
      if (index >= 0) crafting.activeJobs.splice(index, 1);

      // Promote the crafter's next queued craft into the freed active slot.
      const nextIndex = crafting.queue.findIndex((j) => j.crafterEntityId === job.crafterEntityId);
      if (nextIndex >= 0) {
        const next = crafting.queue.splice(nextIndex, 1)[0];
        crafting.activeJobs.push(next);
        console.log(
          `[crafting] entity ${next.crafterEntityId}'s queued '${next.recipeId}' promoted to active at station ${station.id}`,
        );
      }
    }

    if (changed) ctx.world.markDirty(station.id);
  }
}

/**
 * Find the job at `jobIndex` among the crafter's OWN jobs at the station:
 * index 0 is their active job (if any), then their queued jobs in order.
 */
function playersJob(
  crafting: CraftingComponent,
  crafterEntityId: number,
  jobIndex: number,
): CraftingJob | undefined {
  if (jobIndex < 0) return undefined;
  let seen = -1;
  for (const job of [...crafting.activeJobs, ...crafting.queue]) {
    if (job.crafterEntityId !== crafterEntityId) continue;
    seen++;
    if (seen === jobIndex) return job;
  }
  return undefined;
}

/**
 * Cancel one of the crafter's own jobs at a station and refund exactly the
 * items the job consumed when it started — no dupes, no losses. Refunds that
 * cannot fit in the inventory are dropped on the ground.
 */
export function cancelCraft(
  ctx: CraftingContext,
  crafterEntityId: number,
  stationEntityId: number,
  jobIndex: number,
): CraftResult {
  const station = ctx.world.get(stationEntityId);
  if (!station) return fail('no_station');
  const crafting = craftingOf(station);
  if (!crafting) return fail('no_job');

  const job = playersJob(crafting, crafterEntityId, jobIndex);
  if (!job) return fail('not_your_job');

  const activeIndex = crafting.activeJobs.indexOf(job);
  if (activeIndex >= 0) crafting.activeJobs.splice(activeIndex, 1);
  else {
    const queueIndex = crafting.queue.indexOf(job);
    if (queueIndex >= 0) crafting.queue.splice(queueIndex, 1);
  }
  ctx.world.markDirty(stationEntityId);

  const crafter = ctx.world.get(crafterEntityId);
  const dropPos: WorldCoord = crafter
    ? { x: crafter.x, y: crafter.y }
    : { x: station.x, y: station.y };
  const consumed = Array.isArray(job.consumed) ? job.consumed : [];
  console.log(
    `[crafting] entity ${crafterEntityId} cancelled '${job.recipeId}' at station ${stationEntityId} - ` +
      `refunded ${consumed.map((c) => `${c.count}x ${c.itemId}`).join(', ') || '(nothing)'}`,
  );
  for (const input of consumed) {
    giveOrDrop(ctx, crafterEntityId, input.itemId, input.count, dropPos);
  }
  return { ok: true };
}
