import { useEffect, useState } from 'react';
import type {
  CraftingComponent,
  CraftingJob,
  EntityState,
  Intent,
  InventoryComponent,
  RecipeDef,
  RecipeInput,
} from '@game/shared';
import type { Game } from '../game.ts';
import { emojiForItem } from '../emoji-atlas.ts';
import { getItemDef } from '../items.ts';
import { allRecipes } from '../recipes.ts';

const POLL_MS = 200;

/**
 * Phase 6 recipe browser (core UI): lists the recipes craftable at the
 * station the player stands next to (Chebyshev distance 1, like transfers),
 * with a craft button per recipe and progress/cancel controls for the jobs
 * at that station. Recipe definitions come from the registry the server
 * pushes on connect; job state comes from the station entity's `crafting`
 * component in the snapshots. All mutations go through intents — the server
 * is authoritative (it re-validates inputs, adjacency and ownership).
 */
export function RecipePanel({
  game,
  sendIntent,
}: {
  game: Game;
  sendIntent: (intent: Intent) => void;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(() => collect(game));

  useEffect(() => {
    const id = window.setInterval(() => setData(collect(game)), POLL_MS);
    return () => window.clearInterval(id);
  }, [game]);

  if (!open) {
    return (
      <button
        type="button"
        className="craft-toggle-btn"
        aria-label="open recipe panel"
        title="recipe browser"
        onClick={(event) => {
          setOpen(true);
          event.currentTarget.blur(); // keep keyboard shortcuts working
        }}
      >
        ⚒️
      </button>
    );
  }

  const { station, recipes, crafting, player, inventory } = data;
  const jobs = crafting ? [...crafting.activeJobs, ...crafting.queue] : [];

  return (
    <div
      className="recipe-panel"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="recipe-header">
        <span>Crafting</span>
        <span className="recipe-station">{station ? station.kind : 'no station'}</span>
        <button
          type="button"
          className="recipe-close"
          aria-label="close recipe panel"
          onClick={(event) => {
            setOpen(false);
            event.currentTarget.blur();
          }}
        >
          ✕
        </button>
      </div>

      {!station ? (
        <div className="recipe-hint">stand next to a station to see its recipes</div>
      ) : (
        <>
          {recipes.length === 0 ? (
            <div className="recipe-hint">this station has no recipes</div>
          ) : (
            recipes.map((recipe) => {
              const affordable = canAfford(inventory, recipe);
              return (
                <div key={recipe.id} className="recipe-row">
                  <div className="recipe-name">{recipeName(recipe)}</div>
                  <div className="recipe-line">
                    in:{' '}
                    {recipe.inputs.length === 0
                      ? 'nothing'
                      : recipe.inputs
                          .map((input) => {
                            const { emoji, text } = inputSummary(input);
                            return `${input.count}× ${emoji} ${text}`;
                          })
                          .join(', ')}
                  </div>
                  <div className="recipe-line">
                    out:{' '}
                    {recipe.outputs
                      .map((output) => {
                        const def = getItemDef(output.id);
                        return `${output.count}× ${emojiForItem(output.id, def?.tags)} ${
                          def?.name ?? output.id
                        }`;
                      })
                      .join(', ')}
                  </div>
                  <div className="recipe-line">time: {recipe.ticks} ticks</div>
                  <button
                    type="button"
                    className="recipe-craft-btn"
                    disabled={!affordable}
                    title={affordable ? undefined : 'missing inputs'}
                    onClick={(event) => {
                      sendIntent({
                        t: 'intent',
                        kind: 'craft',
                        recipeId: recipe.id,
                        stationEntityId: station.id,
                      });
                      event.currentTarget.blur();
                    }}
                  >
                    craft
                  </button>
                </div>
              );
            })
          )}

          {jobs.length > 0 && (
            <div className="recipe-jobs">
              <div className="recipe-jobs-title">jobs at this station</div>
              {jobs.map((job, index) => {
                const recipe = allRecipes().find((r) => r.id === job.recipeId);
                const owned = player !== null && job.crafterEntityId === player.id;
                const queued = crafting !== null && !crafting.activeJobs.includes(job);
                const jobIndex = crafting && player ? jobIndexOf(crafting, player.id, job) : -1;
                // No Math.* (banned by lint): ~~ is floor for positives, so
                // +0.5 rounds; the > 100 clamp caps a completed job.
                const rawPct = ~~((job.progress / job.totalTicks) * 100 + 0.5);
                const pct = rawPct > 100 ? 100 : rawPct;
                return (
                  <div key={`${index}-${job.crafterEntityId}`} className="craft-job">
                    <div className="craft-job-name">
                      {queued ? '⏳ queued: ' : ''}
                      {recipe ? recipeName(recipe) : job.recipeId}
                      {owned ? ' (you)' : ''} — {job.progress}/{job.totalTicks} ticks
                    </div>
                    <div className="craft-track">
                      <div className="craft-fill" style={{ width: `${queued ? 0 : pct}%` }} />
                    </div>
                    {owned && (
                      <button
                        type="button"
                        className="craft-cancel-btn"
                        onClick={(event) => {
                          sendIntent({
                            t: 'intent',
                            kind: 'cancelCraft',
                            jobIndex,
                            stationEntityId: station.id,
                          });
                          event.currentTarget.blur();
                        }}
                      >
                        cancel
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface PanelData {
  /** The station entity the player stands next to, or null. */
  station: EntityState | null;
  /** Recipes craftable at that station. */
  recipes: RecipeDef[];
  /** The station's crafting component (job state), or null. */
  crafting: CraftingComponent | null;
  /** The local player's entity, or null while disconnected. */
  player: EntityState | null;
  /** The local player's inventory (affordability checks), or null. */
  inventory: InventoryComponent | null;
}

function isCrafting(value: unknown): value is CraftingComponent {
  if (typeof value !== 'object' || value === null) return false;
  const crafting = value as Record<string, unknown>;
  return Array.isArray(crafting.activeJobs) && Array.isArray(crafting.queue);
}

function isInventory(value: unknown): value is InventoryComponent {
  if (typeof value !== 'object' || value === null) return false;
  const inv = value as Record<string, unknown>;
  return Array.isArray(inv.slots) && typeof inv.capacity === 'number';
}

/** Chebyshev distance — stations are used from an adjacent tile. */
function distance(a: EntityState, b: EntityState): number {
  const dx = a.x > b.x ? a.x - b.x : b.x - a.x;
  const dy = a.y > b.y ? a.y - b.y : b.y - a.y;
  return dx > dy ? dx : dy;
}

/** Snapshot-derived panel state: nearest station, its recipes, its jobs. */
function collect(game: Game): PanelData {
  const player = game.localPlayer();
  const inventory = isInventory(player?.components.inventory) ? player.components.inventory : null;
  const snapshot = game.latestSnapshot();
  if (!snapshot || !player) {
    return { station: null, recipes: [], crafting: null, player: player ?? null, inventory };
  }

  // Any entity whose kind is declared as some recipe's station is a station.
  const stationKinds = new Set(allRecipes().map((recipe) => recipe.station));
  let station: EntityState | null = null;
  let best = Infinity;
  for (const entity of snapshot.entities) {
    if (!stationKinds.has(entity.kind)) continue;
    const d = distance(player, entity);
    if (d <= 1 && (d < best || (d === best && (station === null || entity.id < station.id)))) {
      station = entity;
      best = d;
    }
  }
  if (!station) return { station: null, recipes: [], crafting: null, player, inventory };

  return {
    station,
    recipes: allRecipes().filter((recipe) => recipe.station === station.kind),
    crafting: isCrafting(station.components.crafting) ? station.components.crafting : null,
    player,
    inventory,
  };
}

/**
 * True when the player's inventory can supply every input of the recipe.
 * Mirrors the server's matching: exact id, or any item carrying the tag.
 * Reserved slots prevent one stack from satisfying two inputs.
 */
function canAfford(inventory: InventoryComponent | null, recipe: RecipeDef): boolean {
  if (!inventory) return false;
  const reserved = new Map<number, number>(); // slot index -> count already committed
  for (const input of recipe.inputs) {
    let need = input.count;
    for (let i = 0; i < inventory.slots.length && need > 0; i++) {
      const slot = inventory.slots[i];
      if (slot.count <= 0) continue;
      const available = slot.count - (reserved.get(i) ?? 0);
      if (available <= 0) continue;
      const matches =
        input.id !== undefined
          ? slot.itemId === input.id
          : (getItemDef(slot.itemId)?.tags.includes(input.tag ?? '') ?? false);
      if (!matches) continue;
      const take = need < available ? need : available;
      need -= take;
      reserved.set(i, (reserved.get(i) ?? 0) + take);
    }
    if (need > 0) return false;
  }
  return true;
}

/** Human-readable name of a recipe: what it produces. */
function recipeName(recipe: RecipeDef): string {
  return recipe.outputs
    .map((output) => {
      const def = getItemDef(output.id);
      return `${output.count}× ${def?.name ?? output.id}`;
    })
    .join(' + ');
}

function inputSummary(input: RecipeInput): { emoji: string; text: string } {
  if (input.id !== undefined) {
    const def = getItemDef(input.id);
    return { emoji: emojiForItem(input.id, def?.tags), text: def?.name ?? input.id };
  }
  if (input.tag !== undefined) {
    return { emoji: emojiForItem('', [input.tag]), text: `any '${input.tag}'` };
  }
  return { emoji: '❔', text: '???' };
}

/**
 * Index of a job among the player's OWN jobs at the station, in
 * (activeJobs, queue) order — the same rule the server uses to resolve
 * cancelCraft's jobIndex.
 */
function jobIndexOf(crafting: CraftingComponent, playerId: number, job: CraftingJob): number {
  let index = 0;
  for (const candidate of [...crafting.activeJobs, ...crafting.queue]) {
    if (candidate === job) return index;
    if (candidate.crafterEntityId === playerId) index++;
  }
  return -1;
}
