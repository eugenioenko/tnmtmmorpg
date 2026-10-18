import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import buildings from '../features/buildings/index.ts';
import { buildVillage } from '../features/buildings/village.ts';
import portals from '../features/portals/index.ts';
import { World } from '../packages/server/src/world.ts';
import { EventBus } from '../packages/server/src/events.ts';
import { createWorldApi } from '../packages/server/src/world-api.ts';

const world = new World(10000, 10000, 42);
const api = createWorldApi({
  world,
  bus: new EventBus(),
  items: new Map(),
  recipes: new Map(),
  log: () => {},
});
for (const _step of buildVillage(api)) void _step;
portals.systems?.[0].fn(api, 0.1);
const doors = api.query('door').filter((e) => e.kind === 'buildings:door');
const pads = api.query('portal').filter((e) => e.world === 'overworld');
assert.equal(doors.length, 4);
assert.equal(pads.length, 4);

// Follow real walkable tiles from spawn to each door and portal. This catches
// footprints/roads accidentally trapping an entrance or covering a portal.
const reached = new Set(['5000,5000']);
const queue = [{ x: 5000, y: 5000 }];
for (let i = 0; i < queue.length; i++) {
  const at = queue[i];
  for (const [dx, dy] of [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
  ]) {
    const x = at.x + dx,
      y = at.y + dy;
    if (x < 4978 || x > 5022 || y < 4978 || y > 5022) continue;
    const key = `${x},${y}`;
    if (reached.has(key) || !api.walkable(x, y)) continue;
    reached.add(key);
    queue.push({ x, y });
  }
}
for (const entity of [...doors, ...pads]) {
  assert(
    reached.has(`${entity.x},${entity.y}`),
    `Unreachable ${entity.kind} ${entity.x},${entity.y}`,
  );
}
const kinds = new Set<string>();
for (let y = 4978; y <= 5022; y++) for (let x = 4978; x <= 5022; x++) kinds.add(api.tile(x, y));
for (const kind of ['grass', 'forest', 'dirt', 'water', 'sand', 'swamp', 'mountain', 'snow']) {
  assert(kinds.has(kind), `Missing terrain: ${kind}`);
}
console.log('Village: four reachable houses, four reachable portals, eight terrain types.');

const player = api.spawn('player', { x: 5000, y: 5000 });
const enter = buildings.commands!.find((c) => c.name === 'buildings:enter')!.fn;
const travel = portals.commands!.find((c) => c.name === 'portals:use')!.fn;
for (const door of doors) {
  assert(api.move(player, door.x, door.y + 1));
  assert(
    !api.move(player, door.x, door.y - 1),
    `${door.components.label}: wall at ${door.x},${door.y - 1} is ${api.tile(door.x, door.y - 1)}`,
  );
  enter(api, {}, player);
  assert(api.get(player)!.world!.startsWith('interior:'));
  assert(api.walkable(api.get(player)!.x, api.get(player)!.y, api.get(player)!.world));
  enter(api, {}, player);
  assert.equal(api.get(player)!.world, 'overworld');
  assert.equal(api.get(player)!.x, door.x);
  assert.equal(api.get(player)!.y, door.y + 1);
}
for (const pad of pads) {
  assert(api.move(player, pad.x, pad.y));
  travel(api, {}, player);
  assert.notEqual(api.get(player)!.world, 'overworld');
  const at = api.get(player)!;
  assert(api.walkable(at.x, at.y, at.world));
  travel(api, {}, player);
  assert.equal(api.get(player)!.world, 'overworld');
}
console.log('Travel: all four furnished interiors and all four themed worlds return safely.');

// Rebuilding the layout must repair footprints without duplicating content.
const before = world.all().length;
for (const _step of buildVillage(api)) void _step;
assert.equal(world.all().length, before);
const atlas = JSON.parse(
  readFileSync(
    new URL('../packages/client/src/art/harvest-moon/atlas.json', import.meta.url),
    'utf8',
  ),
);
for (const entity of world.all()) {
  const appearance = entity.components.appearance as { frame?: string } | undefined;
  if (appearance?.frame) assert(atlas.frames[appearance.frame], `Missing art: ${appearance.frame}`);
}
for (const [kind, frames] of Object.entries(atlas.terrain)) {
  if (kind !== 'water') assert.equal((frames as unknown[]).length, 1, `${kind} should not animate`);
}
for (const kind of ['grass', 'forest', 'sand', 'dirt', 'swamp', 'mountain', 'snow']) {
  for (let mask = 1; mask < 256; mask++) assert(atlas.frames[`transitions/${kind}/${mask}`]);
}
console.log('Artwork: all props resolve, land stays still, all neighbour edge masks exist.');
