# tnmtmmorpg

A tick-based, grid-based multiplayer world that a group of friends extend by adding **features** — one folder each, no coordination, no merge conflicts.

**Playing now at <https://tnmtmmorpg.yy-dev.top/>** — merging to `main` deploys there automatically ([how](deploy/README.md)).

**The deliverable is not a game.** It is a base where shipping a feature is trivial, so that people keep shipping them — by hand, or by pointing an agent at this README — until *something* emerges. Maybe it becomes a game. Maybe it becomes an incoherent zoo. Maybe it starts falling over in interesting ways. Nobody knows yet, and that is the point: the base exists so the experiment can run.

The only rule that protects the experiment: **features are cheap and disposable, core is not.** Adding a feature should never require touching core. If it does, that is a bug in the base, not in your idea.

---

## Quick start

```bash
pnpm install
pnpm world:reset     # generate a fresh 10000x10000 world (seed 42)
pnpm dev             # server on :3010, client on :5173
```

Open <http://localhost:5173>. Arrow keys move one tile; **WASD strides 100 tiles** for exploring. Click an entity to attack it. `I` toggles the inventory.

```bash
pnpm create-feature my-idea    # scaffold features/my-idea/, runs as-is
pnpm bot                       # headless players, so multiplayer is testable alone
pnpm typecheck && pnpm lint
pnpm --filter @game/server test
```

Requires **Node 24** (runs `.ts` directly, no build step) and **pnpm**.

---

## The one decision that matters: feature or core?

**Default answer: feature. Almost always feature.**

Core owns the *rules of physics*. Features own *everything that happens*. If you are adding a thing that exists in the world — a creature, a plant, an item, a weapon, a profession, a weather system, a god — it is a feature.

| Core owns | Features own |
|---|---|
| Tiles, chunks, terrain generation | Trees, ore, ruins, anything *in* the terrain |
| Entity store, position, collision | Every kind of entity and how it behaves |
| Inventory mechanics, crafting *runtime* | Every item and every recipe |
| The tick loop, snapshots, persistence, the event bus | Combat, farming, NPCs, magic, weather, economy |

This is not aspirational — it is enforced and was paid for. Combat and NPCs originally lived in core; both were moved out. Core now contains **zero** references to `combat`, `npc`, `nature` or `farming`. Check it yourself:

```bash
grep -rn "combat\|npc\|farming\|nature" packages/server/src --include=*.ts | grep -v test-
```

### "But I need core to change"

Sometimes genuinely true — and it is how the API grew. Every method on `WorldAPI` exists because a feature was *blocked*, not because it seemed useful:

- `update()` — combat could not reduce `hp` (`get()` returns detached copies)
- `move()` — NPCs could not walk; core still enforces walkability, so a feature can't step into water
- `queryNear()` / `hasPlayerNear()` — without them, "only simulate near players" degrades into a full-world scan per entity per tick
- `decorateChunk` — trees could only be scattered in a fixed box near spawn

So the bar is: **you tried, and the API made it impossible.** Not inconvenient — impossible. When that happens, open an issue describing what you could not do, and prefer adding a *primitive* to `WorldAPI` over moving your logic into core. The good version of a core change makes many future features possible. The bad version is your feature's logic wearing a core costume.

Warning signs you are about to creep core: core needs to know your namespace string; you are hardcoding your entity kinds in a core file; you are editing `tick.ts` to add a case for your intent (you want a **command** instead — see below).

---

## Writing a feature

```bash
pnpm create-feature mossy-caves
```

You get `features/mossy-caves/` with `index.ts` (server), `client.tsx` (optional UI/sprites) and `README.md` (**required** — one paragraph on what it does). It runs immediately with zero edits.

Nothing else in the repo changes. The server finds features by scanning `features/*/index.ts`; the client finds them via `import.meta.glob`. There is no central registry file, so two people adding features never conflict.

### The shape

```ts
import { definePlugin } from '@game/shared';

export default definePlugin({
  id: 'mossy-caves',
  items: [{ id: 'mossy-caves:moss', name: 'Glowing Moss', tags: ['herb'], stack: 20 }],
  recipes: [],
  entityKinds: ['mossy-caves:spore'],
  systems: [{ name: 'mossy-caves:tick', fn: (world) => { /* every tick, 10x/sec */ } }],
  commands: [{ name: 'mossy-caves:sprout', fn: (world, args, entityId) => { /* player asked */ } }],
  events: { 'entity:death': (world, payload) => { /* someone died nearby */ } },
  decorateChunk: (world, area, rng) => { /* new ground appeared; scatter into it */ },
});
```

**Every id must be namespaced `feature:thing`.** Unnamespaced or duplicate ids fail loudly at boot. That namespace is what lets features coexist blindly.

### The four ways to do something

| | When it runs | Use for |
|---|---|---|
| **system** | every tick (10/sec) | continuous simulation — growth, decay, patrols |
| **command** | a player sent an intent with this `kind` | player actions. This is why you never edit `tick.ts` |
| **event listener** | another feature (or core) emitted it | reacting — loot on `entity:death`, retaliation on `entity:damage` |
| **decorateChunk** | once, when a chunk is first generated | world content — trees, ore, ruins. Fires forever as players explore |

Systems run under a **5ms budget** and a 3-strikes guard: throw or overrun three times and your feature is disabled, loudly, with a banner in the client — while everything else keeps running. Heavy one-off work belongs in `decorateChunk` or spread across ticks, not crammed into one.

### Client half

```tsx
import { defineClient } from '@game/shared';

export default defineClient({
  sprites: { 'mossy-caves:spore': '🍄' },   // entity kind -> emoji, no art pipeline
  items: [...],                              // names/icons for the inventory panel
  panels: { 'mossy-caves:panel': MyPanel },  // any React component
});
```

---

## World API

The **only** surface features get. Core internals are never exposed.

```ts
world.width / world.height                    // world size in tiles

world.spawn(kind, { x, y }, components?)      // -> entity id
world.get(id)                                 // -> DETACHED copy, or undefined
world.update(id, patch)                       // shallow-merge components (write half of get)
world.move(id, x, y)                          // core validates walkability; false if blocked
world.despawn(id)

world.query('inventory', 'stats')             // detached copies carrying all named components
world.queryNear(x, y, radius)                 // spatial-index backed — prefer over query+filter
world.hasPlayerNear(x, y, radius)             // cheap enough to call per entity per tick

world.tile(x, y)                              // 'grass' | 'water' | 'forest' | ...
world.walkable(x, y)                          // the same rule move() enforces
world.setTile(x, y, kind)

world.give(entityId, itemId, count)           // -> leftover that did not fit
world.queryItemsByTag('herb')                 // items from ANY feature — the interop primitive
world.getAvailableRecipes(stationEntityId)

world.emit(event, payload)                    // global
world.emitNear(x, y, radius, event, payload)  // only nearby entities hear it

world.rng()                                   // seeded. Math.random is banned by lint
world.log(msg)
world.getSet(key, value?)                     // persistent kv; check-and-claim in one call
```

**`get()` and `query()` return detached copies.** Mutating them does nothing. Read, build the new value, write it back with `update()`. This is deliberate: it makes accidental cross-feature mutation impossible.

---

## How features compose without knowing about each other

Two mechanisms, both blind:

**Tags.** `world.queryItemsByTag('herb')` returns items from every feature. A recipe asking for `{ tag: 'herb', n: 2 }` consumes `farming:seed` even though the two features share no code. This is the interop test in the suite, and it passes.

**Events.** Emit something; whoever cares listens. Nobody imports anybody.

**Features must never import each other.** If you need another feature's behaviour, emit an event and let it answer. If you want to *offer* an extension point, emit one with a callback in the payload — `features/npc` does this with `npc:register-ais` so any feature can add a creature behaviour.

**Never write another feature's components.** They are reachable through `update()`. Doing it is a review failure, not a technical error.

---

## Theme

**Low fantasy, pre-gunpowder.** No magic that isn't alchemy. No guns, no sci-fi, no cyberpunk. Herbs, minerals, crafting stations, medieval tools, alchemical potions.

This exists so the world stays coherent enough to be recognisably one place. Within it, go strange.

---

## Opening a PR

Before you push:

```bash
pnpm typecheck && pnpm lint
pnpm --filter @game/server test
pnpm dev    # and actually look at it
```

Checklist:

- [ ] Every id namespaced `feature:thing`
- [ ] `features/<name>/README.md` exists — one paragraph, what it does
- [ ] **Nothing under `packages/*` is touched.** If it is, say why in the PR description — that is the part reviewers will actually read
- [ ] No imports from another feature
- [ ] No writes to another feature's components
- [ ] No `Math.random` (lint will catch it — use `world.rng()`)
- [ ] Disabling your feature leaves the world playable

`CODEOWNERS` guards `packages/*`. `features/*` is wide open — nobody needs to approve your idea.

---

## Layout

```
packages/shared/    protocol types, WorldAPI contract, tag matcher, seeded RNG
packages/server/    tick loop, world, persistence, sync, feature loader   <- rarely touch
packages/client/    PixiJS renderer + React overlay                        <- rarely touch
features/           everything that actually happens                       <- live here
tools/              create-feature, bot, world:reset
```

Read `features/_example/` first — it is the tutorial feature, kept working on purpose. Then `features/combat/` and `features/npc/` for real ones that were extracted out of core, which is the clearest evidence of where the line sits.

Deeper detail: `CONTRIBUTING.md`. Architecture and phase history: `project.md`.

---

## For agents

If you are an agent helping someone add to this world, the short version:

1. **Everything is a feature.** Scaffold with `pnpm create-feature <name>` and stay inside that folder.
2. **Never edit `packages/*`** without stopping to tell the human why it is unavoidable, and what `WorldAPI` primitive would have made it avoidable instead.
3. **Namespace every id.** Boot fails loudly otherwise.
4. Prefer **command** over new intents, **event** over cross-feature imports, **tags** over item-id checks, **`decorateChunk`** over one-shot bootstrap systems.
5. **Verify by running it**, not by reading it. Green tests have hidden real breakage in this repo before — a chunk-decoration bug passed unit tests while leaving the actual spawn area empty. Boot the server and look.
6. Keep `pnpm typecheck`, `pnpm lint` and the test suite green, and mention anything you left broken rather than quietly narrowing scope.
