# tnmtmmorpg — Project Plan

A tick-based, grid-based multiplayer RPG with a crafting core. **The deliverable is not a game — it is a base that makes it trivial for a group of developer friends to each ship a feature.**

Everything below is organised into phases. Each phase has a hard **Validation** gate. Do not start phase N+1 until phase N's validation passes end to end — a half-working base is what kills contributor momentum.

---

## 1. Goals

- A contributor clones the repo, runs one command, and has a running local world in under 5 minutes.
- A contributor ships a working feature (items + recipes + a system + a UI panel) in under an hour, without reading core code.
- Features compose without coordination — via **tags** and **events**, never by importing each other's internals.
- One broken feature degrades to "that feature is off", never "the server is down".
- The shared world is always on and persists.

## 2. Non-goals (explicitly out of scope)

Real auth (name + token in a file is enough) · anti-cheat · sharding/zones beyond chunk interest · client-side prediction or rollback · balance · an art pipeline · mobile · Windows support.

## 3. Locked decisions

| Area | Decision | Why |
|---|---|---|
| Tick model | Grid-based, fixed **10 ticks/sec** | Server is trivially authoritative. No prediction, no reconciliation, no lag comp. |
| Language | **TypeScript end-to-end** | One language, shared types, lowest contributor barrier. |
| Runtime | **Node 24 LTS** (v24.15.0 verified), native TS type stripping | `node file.ts` runs directly — no build step on the server, no `tsx` dependency. Erasable-syntax-only: no enums, no parameter properties, no namespaces. |
| Package manager | **pnpm workspaces** (v11 verified) | Fast, strict, good monorepo story. |
| Persistence | **`node:sqlite`** (built in) | Zero native modules. No node-gyp, no toolchain drift between macOS arm64 and Linux. |
| Transport | **WebSocket, JSON messages** | Readable in devtools. Optimise only when measured. |
| World rendering | **PixiJS** (renderer only, not a framework) | Batched WebGL, no opinion about the game loop, small API surface. Phaser/Kaplay would fight the server-authoritative design. |
| UI | **React over DOM**, layered on the canvas | Contributors write panels as normal web UI. In-canvas UI is the worst DX decision available. |
| Bundler | **Vite** | Fast, and `import.meta.glob` gives us zero-config feature discovery on the client. |
| OS support | **macOS + Linux**. Server deploys to Linux. | Client is a browser app, so players get every OS for free anyway. |

## 4. Architecture summary

```
┌─────────────────────────────┐        WebSocket (JSON)        ┌──────────────────────┐
│  React overlay (DOM)        │  ── intent ──────────────────▶ │  Server (Node 24)    │
│  panels · inventory · chat  │                                │  10Hz authoritative  │
│  ┌───────────────────────┐  │  ◀──── snapshot / patch ─────  │  loop · world API    │
│  │  Pixi canvas          │  │                                │  node:sqlite         │
│  │  tiles · entities     │  │                                └──────────────────────┘
│  └───────────────────────┘  │
└─────────────────────────────┘
```

**Core has no game in it.** Core owns tiles, position, movement/collision, inventories, the crafting *runtime*, and sync. Combat, farming, magic, mining, NPCs are all features. Individual recipes are features; the recipe registry and tag matcher are core.

### The tick

```
1. drain intent queue      -> validate, dispatch to command handlers
2. run systems in order    -> each in try/catch, with a per-system time budget
3. flush event bus         -> listeners fire (queued, never reentrant)
4. build per-player patch  -> only chunks inside their view radius
5. every 50 ticks          -> persist dirty entities
```

Three thrown errors in a feature's system auto-disables that feature, loudly, and the loop keeps running.

**Seeded RNG only.** `world.rng()` is seeded per tick; `Math.random` is banned by lint rule. Buys reproducible local worlds and replayable bug reports for free.

### Repo layout (target)

```
tnmtmmorpg/
  packages/
    shared/          protocol types, item/recipe/entity types, tag matcher, seeded RNG
    server/          tick loop, ws, persistence, world API, feature loader
    client/          vite + pixi renderer, react panel host, input -> intents
  features/
    _example/        the tutorial feature — real, shipped, kept working
      index.ts       server: items, recipes, systems, commands, event handlers
      client.tsx     optional: sprites + UI panels
      README.md      one paragraph, mandatory
  tools/
    create-feature.mjs
    bot.mjs          headless fake players
    reset-world.mjs
  project.md
```

---

# Phases

## Phase 0 — Toolchain skeleton

**Goal:** an empty but correctly wired monorepo.

**Scope**
- `pnpm-workspace.yaml`, root `package.json`, `tsconfig.base.json`, `.gitignore`, `git init`
- Empty `packages/shared`, `packages/server`, `packages/client` with package.json + tsconfig
- `@game/shared` resolves from both server and client
- ESLint + Prettier, including the `no-restricted-globals: Math.random` rule
- Root scripts: `dev`, `typecheck`, `lint`

**Validation**
1. `pnpm install` completes clean on a fresh clone.
2. `pnpm typecheck` passes across all three packages.
3. `pnpm lint` passes, and a deliberately added `Math.random()` **fails** it.
4. A `const x: Foo` imported from `@game/shared` type-checks in *both* server and client.
5. `node packages/server/src/index.ts` runs a stub without a build step (proves native type stripping).

---

## Phase 1 — Walking skeleton

**Goal:** two browsers, two squares, moving on a grid, driven by an authoritative server.

**Scope**
- Fixed 10Hz tick loop with drift-corrected accumulator
- Entity store: `id`, `kind`, `components` bag; `world.spawn/get/query/despawn`
- Tile map: hardcoded chunk of grass/wall, collision check on move
- WebSocket server, session per connection, player entity on connect
- Intent: `{ t:'intent', kind:'move', dir:'n'|'s'|'e'|'w' }`
- Server sends full `snapshot` every tick (no deltas yet)
- Throwaway client: plain canvas, colored rects, arrow keys

**Validation**
1. Two browser tabs connect; each sees **both** squares.
2. Arrow keys in tab A move A's square in tab B within ~100ms.
3. Walking into a wall does nothing — movement is rejected server-side.
4. Sending a forged intent (`dir: 'nw'`, or moving another player's entity) is rejected and logged, not applied.
5. Server log shows a stable tick rate of 10/sec ±1 over 60 seconds, with no drift accumulation.
6. Killing the server disconnects clients cleanly; restarting lets them reconnect without a page reload.

---

## Phase 2 — Persistence

**Goal:** the world survives a restart.

**Scope**
- `node:sqlite` schema, schemaless component storage:
  ```sql
  entities(id INTEGER PRIMARY KEY, kind TEXT, chunk TEXT, data TEXT /*JSON*/, rev INTEGER)
  tiles(chunk TEXT PRIMARY KEY, data BLOB)
  players(id TEXT PRIMARY KEY, name TEXT, entity_id INTEGER, token TEXT)
  kv(k TEXT PRIMARY KEY, v TEXT)
  ```
- Dirty-entity tracking; flush every 50 ticks and on `SIGINT`/`SIGTERM`
- World path from env (`WORLD_DB=.data/dev.sqlite`) — this is what makes local dev instances work
- `tools/reset-world.mjs` — deterministic seeded world generation

**Scope note:** components live inside the `data` JSON blob. No migrations, ever. The moment contributing requires a migration, contributions stop.

**Validation**
1. Move a player, `Ctrl-C` the server, restart — the player is at the same tile.
2. Kill the server with `SIGKILL` mid-tick; on restart the DB opens without corruption and loses at most 5 seconds.
3. `pnpm world:reset` twice with the same seed produces byte-identical worlds.
4. `WORLD_DB=.data/a.sqlite` and `WORLD_DB=.data/b.sqlite` run simultaneously on different ports without interfering.
5. Adding a new field to a component requires **zero** schema changes and old rows still load.

---

## Phase 3 — Real renderer

**Goal:** it looks like a game and feels smooth.

**Scope**
- Replace throwaway canvas with **PixiJS**: tilemap layer, entity layer, camera following the player
- **Render at 60fps, tick at 10Hz** — lerp entity positions between the last two snapshots. Visual smoothing only; the server remains the sole truth.
- Snapshot buffer (hold ~2 snapshots, render ~1 tick behind)
- React overlay mounted above the canvas; a debug panel showing tick, ping, entity count
- Emoji-to-texture-atlas baker for placeholder sprites — every entity kind gets a glyph, zero art pipeline

**Validation**
1. Movement is visibly smooth at 60fps despite the 10Hz tick — no stepping or stutter.
2. Camera follows the local player; the world scrolls, the player stays centred.
3. Resizing the browser window re-lays out both canvas and overlay correctly.
4. A DOM panel renders above the canvas, is clickable, and its clicks do **not** leak into the canvas input handler.
5. 500 entities on screen hold 60fps (spawn them with a debug command).
6. Disconnecting mid-render freezes entities rather than crashing or teleporting them.

---

## Phase 4 — Plugin system

**Goal:** the seam that the whole project exists for.

**Scope**
- `definePlugin()` / `defineClient()` types in `@game/shared`
- Server loader: fs scan of `features/*/index.ts` + dynamic import. No central registry file — nobody merge-conflicts.
- Client loader: `import.meta.glob('../../features/*/client.tsx')`
- Registries: items, recipes, entity kinds, systems, commands, event listeners — all namespaced `feature:thing`
- **Error isolation:** per-system try/catch, time budget, 3-strikes auto-disable, banner surfaced to the client
- `FEATURES=farming,alchemy` env to run a subset
- Sanctioned world API — the only mutation surface:
  ```ts
  world.spawn(kind, { x, y })      world.get(id)      world.despawn(id)
  world.query('position', 'inventory')
  world.tile(x, y)                 world.setTile(x, y, t)
  world.give(entity, 'farming:wheat', 3)   // -> leftover
  world.emit('entity:death', { id })
  world.rng()                      world.log
  ```
- House rule, enforced by review: **never mutate another feature's components directly.** Talk via events or exported helpers.

**Validation**
1. Dropping in a new feature folder and restarting makes it live — no other file edited.
2. Two features declaring the same unnamespaced id fail loudly at boot with a clear message.
3. A feature whose system throws every tick is auto-disabled after 3 strikes; **every other feature keeps running** and the client shows a banner.
4. A feature with an infinite loop trips the time budget and is disabled rather than hanging the server.
5. `FEATURES=_example` boots with only that feature registered.
6. A feature registering a client panel and a sprite gets both without touching core client code.
7. Removing a feature folder leaves its persisted entities loadable-but-inert (no crash on unknown kind).

---

## Phase 5 — Items and inventory

**Goal:** things exist, are carried, stack, and can be put down.

**Scope**
- Item definition: `{ id, name, tags[], stack, sprite }` — registered by features
- `inventory` component: slots, stacking, capacity
- Ground drops as entities; pick up / drop intents
- Containers (a chest entity kind) with transfer between inventories
- React inventory panel with drag-and-drop
- **Tags are the interop primitive** — `['herb','plant']`, not item-id checks

**Validation**
1. Pick up an item, see it in the inventory panel, drop it, see it on the ground in another client.
2. Stacking respects `stack` limits; overflow leaves the remainder on the ground.
3. Two players grabbing the same ground item in the same tick: exactly one gets it, no duplication.
4. A full inventory rejects pickup without destroying the item.
5. Transfer to a chest, restart the server, the chest still has the item.
6. Query by tag returns items registered by a *different* feature.

---

## Phase 6 — Crafting and stations

**Goal:** the core loop, and the composition point that makes features interoperate.

**Scope**
- Recipe definition, matching by **tag or id**:
  ```ts
  { id: 'alchemy:healing_potion', station: 'alchemy:cauldron',
    in:  [{ tag: 'herb', n: 2 }, { id: 'alchemy:vial', n: 1 }],
    out: [{ id: 'alchemy:potion_heal', n: 1 }],
    ticks: 30 }
  ```
- Station entity kind + `crafting` component; timed jobs progressed by the core system
- `craft` intent: validate inputs server-side, consume, queue, produce on completion
- Recipe browser panel, filtered by the station you're standing at
- `_example` feature ships one station and one recipe end to end

**Validation**
1. Craft at a station: inputs consumed, progress ticks visible in both clients, output appears.
2. Walking away mid-craft does not cancel or duplicate the job.
3. Cancelling a job refunds exactly the inputs — no dupe, no loss.
4. Server restart mid-craft resumes the job at the correct progress.
5. **The interop test:** a recipe in feature A with `{ tag: 'herb' }` successfully consumes an item registered by feature B, with no code shared between them.
6. A forged craft intent for a recipe whose inputs you lack is rejected server-side.
7. Two players crafting at the same station simultaneously behave sanely (queue or per-player jobs — decide and document which).

---

## Phase 7 — Contributor DX

**Goal:** this is the actual product. Do not invite anyone before this passes.

**Scope**
- `pnpm create-feature <name>` — scaffolds folder, `index.ts`, `client.tsx`, `README.md`
- `pnpm bot` — headless fake players that wander, pick up and craft, **so multiplayer is testable alone**
- `pnpm dev` — server + client + seeded local world, one command, feature hot-reload
- `pnpm world:reset`
- `CONTRIBUTING.md`: the 20-line hello-world feature, the world API reference, the house rules, and the **theme constraint**
- `CODEOWNERS`: `packages/*` owned, `features/*` wide open
- Feature API version constant; breaking it is a deliberate, announced act

**Validation**
1. **The real test:** a friend clones the repo on a machine you have never touched and ships a working feature in under an hour with no help from you. If they get stuck, that stuck point is a Phase 7 bug, not a them problem.
2. `pnpm dev` works from a fresh clone on both macOS and Linux with only `pnpm install` first.
3. `pnpm bot` spawns 2 players that visibly move and craft, alone on a dev machine.
4. Editing a feature file hot-reloads without a server restart or a lost world.
5. `create-feature` output runs immediately with zero edits.
6. Every doc code sample is copy-pasteable and actually compiles.

---

## Phase 8 — Deploy the shared world

**Goal:** always-on, so progress accumulates and the world feels shared.

**Scope**
- Cheap Linux VPS, systemd unit, auto-restart on crash
- Nightly SQLite backup with a **tested restore**
- Name + token auth, tokens issued by hand
- Basic ops: `journalctl` logging, tick-rate and memory metrics, feature-disabled alerts
- Deploy = git pull + restart (keep it that dumb)

**Validation**
1. `systemctl restart` brings the world back with state intact.
2. Kill -9 the process; systemd restarts it within 10s and clients reconnect on their own.
3. Restore last night's backup into a scratch instance and boot it successfully — an untested backup is not a backup.
4. Two people connect from different networks and see each other.
5. A deliberately broken feature deployed to prod disables itself; the world stays up.
6. 24 hours of uptime with no memory growth and a stable tick rate.

---

## Phase 9 — Open it up

**Goal:** friends build the game.

**Scope**
- Publish the theme constraint and the feature API contract
- Seed 2–3 example features of genuinely different shapes (a crafting chain, a world-simulation system, a UI-heavy one) so contributors have varied patterns to copy
- A lightweight claim process (a GitHub issue per feature idea) so two people don't build the same thing
- PR review checklist: namespaced ids · no cross-feature mutation · a README · doesn't touch `packages/*`

**Validation**
1. Three contributed features run simultaneously in the shared world without conflicts.
2. At least one pair of independently written features interoperates through tags or events, unplanned.
3. Disabling any one contributed feature leaves the world fully playable.

---

## 5. Standing risks

- **Incoherent world.** "Build whatever you want" reads as noise without a fence — cyberpunk drones next to a medieval smithy. Pick a loose but real theme ("low fantasy, pre-gunpowder, no magic that isn't alchemy") and put it at the top of `CONTRIBUTING.md` **before** Phase 9.
- **Breaking the feature API.** Once is survivable, twice and people stop opening the repo. Version it from the first commit and treat breakage as a big deal.
- **Inviting too early.** A base that is 80% done spends your friends' enthusiasm on debugging your loader instead of building. Enthusiasm is the scarcest resource in this project.
- **Core creep.** Every "just put it in core for now" is a future merge conflict for six people. If it's game content, it's a feature.
