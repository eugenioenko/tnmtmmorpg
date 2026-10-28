# tnmtmmorpg

A tick-based, grid-based multiplayer world that a group of friends extend by adding **features** — one folder each, no coordination, no merge conflicts.

**Playing now at <https://mmorpg.skedoodle.top/>** — merging to `main` deploys there automatically ([how](deploy/README.md)).

**The deliverable is not a game.** It is a base where shipping a feature is trivial, so that people keep shipping them — by hand, or by pointing an agent at this README — until *something* emerges. Maybe it becomes a game. Maybe it becomes an incoherent zoo. Maybe it starts falling over in interesting ways. Nobody knows yet, and that is the point: the base exists so the experiment can run.

The only rule that protects the experiment: **features are cheap and disposable, core is not.** Adding a feature should never require touching core. If it does, that is a bug in the base, not in your idea.

---

## Quick start

```bash
pnpm install
pnpm world:reset     # generate a fresh 10000x10000 world (seed 42)
pnpm dev             # server on :3010, client on :5173
```

Open <http://localhost:5173>, create a character, and play. Locally you get an account tied to the browser; set `OIDC_ISSUER_URL` (server) and `VITE_OIDC_ISSUER_URL` + `VITE_OIDC_CLIENT_ID` (client) to sign in through an OpenID Connect provider instead, as production does with autentico. Each account holds up to 8 characters; **Game Menu** (⚙️) switches between them. **Click** the ground to walk there, click a creature to fight it, click a person, door or travel pad to use it, click another player to trade. Arrow keys or WASD walk (hold to keep going), **Space** uses whatever is in reach, **Tab** targets the nearest enemy, `1`–`6` use quick-slot items, **Enter** chats (`/help` lists channels and emotes, `R` replies to a whisper). Windows: `C` character, `I` inventory, `J` journal, `K` crafting, `P` professions, `L` your path, `O` party. `/invite Name` forms a party of up to five that shares kills, quest credit and cave copies; `/p` talks to it. You pick a class (Warrior, Ranger or Mystic) when creating a character, or later at level 5; whose abilities sit on `Q` `F` `G` `T` and use your current target. **F3** opens the developer drawer (connection stats, feature test buttons; Shift+WASD strides 100 tiles for exploring).

```bash
pnpm create-feature my-idea    # scaffold features/my-idea/, runs as-is
pnpm bot                       # headless players, so multiplayer is testable alone
pnpm typecheck && pnpm lint
pnpm --filter @game/server test
```

Requires **Node 24** (runs `.ts` directly, no build step) and **pnpm**.

Temporary graphics use a shared Harvest Moon sprite atlas, including animated
player characters, objects, and terrain. Open `/art.html` on the client dev server
to browse the extraction. See [the artwork notes](packages/client/src/art/harvest-moon/README.md)
for organization, rebuilding, and replacement with the final art.
Players start in a village beside four labeled travel pads. The elder, the guard
captain, the alchemist and the trader hand out quests and trade; the wilds outside
the village get more dangerous the farther you go, and each world beyond the pads
has its own creatures. Cave mouths in the hills lead to instanced dungeons with a
guardian and its hoard at the bottom; the first is a short walk north of the village.
With a pickaxe or hatchet from the trader you can mine ore veins and fell trees, then
smelt, saw and smith your own gear at the forge and sawbench in the square. Characters are saved on logout and every few seconds while playing.

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
  privateComponents: ['mossy-caves:secrets'], // only the owner's client ever receives these
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
  items: [...],                              // names, icons, descriptions, `use` command
  interactions: {                            // click it / Space beside it
    'mossy-caves:altar': { intent: 'mossy-caves:pray', label: 'Pray at' },
    // also: range, quickUse: false (click only), opens: 'crafting' (open a window
    // instead of sending), requires: 'item:id' (only while carrying that item)
  },
  windows: {                                 // framed HUD window + action-bar button
    'mossy-caves:log': { title: 'Spores', icon: '🍄', hotkey: 'KeyP', component: SporeLog },
  },
  hud: { 'mossy-caves:meter': SporeMeter },  // always-on widget, right-hand column
  overlay: { 'mossy-caves:glow': GlowLayer }, // full-canvas layer you position yourself
  panels: { 'mossy-caves:dev': DevButtons }, // developer tools, shown in the F3 drawer
  creation: {                                // a pick on the character creation screen
    label: 'Spore affinity',
    options: [{ id: 'cap', label: 'Cap', icon: '🍄', blurb: 'Shown under the option.' }],
  },
});
```

A `creation` pick reaches the server in the `'player:enter'` event (`{ entityId, name, created, traits }`) as `traits['mossy-caves']`. To keep something on a player across logouts, list its component in `persistComponents: ['mossy-caves:spores']` on the server half; core saves it with the character.

Window and HUD components receive `{ client }` — a read-only view of the newest snapshot (`client.localPlayer()`, `client.subscribe(...)`), `client.sendIntent`, `client.notify` for the message log, and `client.screenOf(id)` to pin HTML over an entity as it walks (see the speech bubbles in `features/chat`). Two components on an entity also mean something to the HUD without any client code: `interact: { intent, label, range? }` makes that one entity usable, and a `dialog: { name, text, options: [{ label, intent }], closeIntent }` component on a player opens a conversation box whose options send their intents (see `features/town`).

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
