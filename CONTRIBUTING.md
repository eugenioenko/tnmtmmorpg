# Contributing to tnmtmmorpg

## Quick start

1. Clone the repo
2. `pnpm install`
3. `pnpm dev` — starts server + client, opens http://localhost:5173
4. `pnpm create-feature my-idea` — scaffolds your feature
5. Start building!

Requirements: Node 24 LTS (v24.15.0+), pnpm 11, macOS or Linux.

## Theme constraint

**Low fantasy, pre-gunpowder.** No magic that isn't alchemy. No guns, no sci-fi tech, no cyberpunk. Think: herbs, minerals, crafting stations, medieval tools, alchemical potions. If you're unsure, ask in your feature's GitHub issue before building.

## The 20-line hello-world feature

A feature is a folder with one server file, an optional client file and a README. Nothing outside your folder ever needs to change — the server scans `features/*/index.ts` at boot, the client discovers `features/*/client.tsx` via `import.meta.glob`. Save this as `features/hello/index.ts`:

```ts
import { definePlugin } from '@game/shared';

export default definePlugin({
  id: 'hello',
  items: [{ id: 'hello:stone', name: 'Hello Stone', tags: ['stone', 'mineral'], stack: 20 }],
  recipes: [],
  entityKinds: [],
  systems: [],
  commands: [
    {
      name: 'hello:wave',
      fn: (world, _args, entityId) => {
        world.give(entityId, 'hello:stone', 1);
        world.log(`waved at entity ${entityId} - enjoy your stone`);
      },
    },
  ],
  events: {},
});
```

The dev server hot-reloads the moment you save (see "Feature hot-reload" below). To make the stone render in the inventory panel, add `features/hello/client.tsx`:

```tsx
import { defineClient } from '@game/shared';

export default defineClient({
  items: [{ id: 'hello:stone', name: 'Hello Stone', tags: ['stone', 'mineral'], stack: 20 }],
  panels: {},
  sprites: {},
});
```

That's the whole feature. Send the intent `{ t: 'intent', kind: 'hello:wave' }` (via the chat/debug console or a panel button) and the sender gets a stone.

## Feature API version

`@game/shared` exports `FEATURE_API_VERSION` (currently `1`). Bumping it means the feature API contract changed in a breaking way — a deliberate, announced act, never an incidental one. If you change the shape of `definePlugin`/`defineClient`, the `WorldAPI`, or the wire messages in a way that breaks existing features, bump it and say so in the changelog/issue before merging. Check the version with:

```
node -e "import('@game/shared').then((m) => console.log(m.FEATURE_API_VERSION))"
```

## World API reference

Everything a feature gets is the `WorldAPI` — the only sanctioned mutation surface. Core internals (the world class, entity store, persistence) are never exposed. Entities are `{ id, kind, x, y, components }` where `components` is a bag of named components.

| Method | What it does |
|---|---|
| `world.spawn(kind, { x, y }, components?)` | Spawn an entity of `kind` at a position; returns its id. |
| `world.get(id)` | A detached copy of an entity's state, or `undefined` if it is gone. |
| `world.despawn(id)` | Remove an entity from the world. |
| `world.query(...componentNames)` | Every entity carrying **all** of the named components (detached copies). |
| `world.tile(x, y)` | Tile kind at `(x, y)`; out-of-bounds reads as `'wall'`. |
| `world.setTile(x, y, kind)` | Change a tile's kind (e.g. `'grass'`, `'wall'`). |
| `world.give(entityId, itemId, count)` | Hand `count` of an item to an entity; returns how many were **not** accepted (leftover). |
| `world.queryItemsByTag(tag)` | Every registered item definition carrying a tag, across all features. |
| `world.getAvailableRecipes(stationEntityId)` | Every recipe craftable at a station entity, matched by its kind. |
| `world.emit(event, payload)` | Queue an event for the bus; listeners fire after systems run. |
| `world.rng()` | Seeded, deterministic random in `[0, 1)`. `Math.random` is banned by lint. |
| `world.log(msg)` | Log with your feature's prefix (`[feature:<your-id>]`). |

Systems run every tick (`fn: (world, delta) => ...`, `delta` in seconds), in registration order, each in its own try/catch with a time budget. Three failures auto-disable your feature's system loudly, and everything else keeps running.

## House rules

- **Namespaced ids.** Every item, recipe, entity kind, system and command id is `feature:thing` (e.g. `farming:seed`, `_example:glowing_essence`). Ids are unique across the whole world — a collision fails boot loudly, naming both claimants. Event keys are exempt: listening to the same event (e.g. `entity:death`) from several features is the point of the bus.
- **Never mutate another feature's components directly.** If you need something from another feature, compose through tags (recipes match inputs by tag) or events (`world.emit` / listeners). Export a helper only if events cannot express it. Review-enforced.
- **Always a README.** One paragraph minimum: what the feature does, its items, recipes, systems, commands. Delete sections you don't need.
- **`plugin.id` must equal the folder name** — the folder is the feature's identity (used by `FEATURES=` and log prefixes).
- **Game content is a feature.** Core (`packages/*`) owns tiles, movement, inventories, the crafting runtime and sync. If it's game content, it's a feature. Core creep is a merge conflict for six people.
- **`Math.random` is banned** by lint — use `world.rng()`.

## Testing with `pnpm bot`

`pnpm bot` spawns headless fake players so you can test multiplayer alone:

```
pnpm dev                    # terminal 1: server + client
pnpm bot -- --count 2       # terminal 2: two bots connect and play
```

Each bot connects exactly like a browser player, then wanders (a wall-aware random walk every 2-5s), picks up ground items it stands on, and crafts at any station it can reach with recipes whose inputs it holds. On a fresh world the bots use the `_example` feature's own commands to stock up on stones and spawn a practice workbench, so you should see `[Bot-1] craft _example:polished_stone at station #N` within a few seconds. Ctrl-C disconnects all bots cleanly. Direct invocation works too:

```
node tools/bot.mjs --count 2 --url ws://localhost:3010 --seed 42
```

## Feature hot-reload

The server dev script watches `features/` (`node --watch --watch-path=../../features src/index.ts`), so editing any file under `features/` restarts the server automatically — the world is not lost, it lives in SQLite and reloads. Creating a new feature folder is picked up the same way. Client changes hot-reload through Vite without even a page refresh. A change under `packages/*` still needs a manual restart.

## World reset

The world persists in `.data/dev.sqlite`. `pnpm world:reset` wipes it and regenerates a deterministic seeded map (add `-- --seed N` for a specific seed).
