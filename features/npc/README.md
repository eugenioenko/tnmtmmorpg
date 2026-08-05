# npc

Wandering creatures: the population that makes the world feel inhabited, and the only thing in the repo that moves on its own. A fresh world is seeded once with 20 NPCs on walkable tiles near the world centre (players spawn there too), guarded by the persistent kv flag `npc:seeded` so a restart never double-seeds. Each NPC is an ordinary entity of kind `npc` carrying three components: `npc` (behaviour name, state, leash anchor), `movement` (speed 0.2 — one tile every 5 ticks) and `stats` (hp 30, atk 8, def 2, so combat can hurt it and it can hit back). All three persist like any other entity blob.

The single system `npc:tick` does four things per tick. **Spatial sleeping** first: an NPC with no player within 64 tiles (`world.hasPlayerNear`) runs no AI, allocates nothing and logs nothing — that is what makes a 10000x10000 world with a scattered population free. Then **AI dispatch** for everything awake, then **movement**, then **chase attacks**: a chasing NPC whose target is adjacent emits `npc:attack { attackerId, targetId }` every 10 ticks. This feature decides *when* an NPC swings, because that is AI; what a swing *does* is `features/combat`'s business. With combat uninstalled, swings are inert and nothing else changes. The reverse hook is the `entity:damage` listener: an NPC that takes a hit drops what it was doing and chases whoever hit it.

Nothing here touches core state directly. Movement is a request — `world.move(id, x, y)` returns `false` when core refuses the tile — so no behaviour, however wrong its arithmetic, can walk an NPC into water; `world.walkable(x, y)` is the same rule, readable, which the built-in A* uses to plan. Uninstall the feature and persisted NPCs simply sit there as inert entities.

## Writing a behaviour from another feature

There is no AI registry in core. This feature owns the concept and offers it as an extension point over the ordinary event bus: on its first tick `npc:tick` emits `npc:register-ais` with a `register` callback, and any feature can answer from its own `events` map.

```ts
import type { EntityState, WorldAPI } from '@game/shared';

type RegisterAI = (
  name: string,
  fn: (world: WorldAPI, entity: EntityState, nearby: EntityState[], tick: number) => void,
) => void;

export default definePlugin({
  // ...
  events: {
    'npc:register-ais': (_world, payload) => {
      const register = (payload as { register?: unknown }).register as RegisterAI | undefined;
      if (typeof register !== 'function') return;
      register('myfeature:skittish', (world, entity, nearby) => {
        const npc = entity.components.npc;
        if (!isNPCComponent(npc)) return;
        npc.state = nearby.some((e) => e.kind === 'player') ? 'fleeing' : 'wandering';
      });
    },
  },
});
```

Put the registered name in an NPC's `npc.ai` component when you spawn it (`world.spawn('npc', { x, y }, { npc: { ai: 'myfeature:skittish', ... } })`) and it runs instead of the built-in. No import between features, and the name is yours: `register` refuses `'wander'` (the built-in) and refuses a name already taken.

The contract: `entity` is a **detached snapshot** of the NPC. Mutate its `npc` and `movement` components — set `movement.dir` to `'n' | 's' | 'e' | 'w'` to request a step, set `npc.state` to `'idle' | 'wandering' | 'chasing' | 'fleeing'` and `npc.target` to an entity id — and `npc:tick` writes them back through `world.update()` and performs the actual step. Never assign `entity.x`/`entity.y`; that is core's, via `world.move()`. `nearby` holds detached copies of everything within 6 tiles. Your behaviour runs inside this feature's system, so core's guard would blame `npc:tick` for your exception: instead it is caught here, logged, and after three throws your behaviour is dropped and its NPCs fall back to `wander`. The built-in `wander` handles idle/wandering with random pauses, a 2-chunk leash around the spawn chunk, chasing along a bounded A* path and fleeing directly away — so a behaviour that only sets `npc.state` and `npc.target` gets all of that for free.
