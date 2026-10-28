/**
 * The caves generator: every cave must be fully connected from its entry
 * tile (a sealed chamber would strand a guardian or a player), deep enough
 * to be a dungeon, and identical across copies and restarts.
 */
import { DUNGEON_ENTRY, DUNGEON_SIZE, TILE_FLOOR, dungeonSpec, dungeonWorldId, resolveWorld } from '@game/shared';
import { generateCaves } from './world-chunks.ts';

let failed = 0;

function ok(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok - ${label}`);
  } else {
    failed++;
    console.log(`  NOT OK - ${label}`);
  }
}

function survey(data: Uint8Array): { floor: number; reached: number; deepest: number } {
  const at = (x: number, y: number): number => data[y * DUNGEON_SIZE + x];
  let floor = 0;
  for (const b of data) if (b === TILE_FLOOR) floor++;
  const dist = new Map<number, number>([[DUNGEON_ENTRY.y * DUNGEON_SIZE + DUNGEON_ENTRY.x, 0]]);
  const queue = [DUNGEON_ENTRY.y * DUNGEON_SIZE + DUNGEON_ENTRY.x];
  let deepest = 0;
  for (let i = 0; i < queue.length; i++) {
    const k = queue[i];
    const x = k % DUNGEON_SIZE;
    const y = (k / DUNGEON_SIZE) | 0;
    const d = dist.get(k) ?? 0;
    if (d > deepest) deepest = d;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < 0 || ny < 0 || nx >= DUNGEON_SIZE || ny >= DUNGEON_SIZE) continue;
      const nk = ny * DUNGEON_SIZE + nx;
      if (dist.has(nk) || at(nx, ny) !== TILE_FLOOR) continue;
      dist.set(nk, d + 1);
      queue.push(nk);
    }
  }
  return { floor, reached: dist.size, deepest };
}

let allConnected = true;
let allEntry = true;
let shallowest = Infinity;
let edgeFloor = false;
for (let i = 0; i < 200; i++) {
  const spec = dungeonSpec(dungeonWorldId(4000 + i * 37, 6000 - i * 53, 0))!;
  const data = generateCaves(spec.seed, 0, 0);
  if (data[DUNGEON_ENTRY.y * DUNGEON_SIZE + DUNGEON_ENTRY.x] !== TILE_FLOOR) allEntry = false;
  const s = survey(data);
  if (s.reached !== s.floor) allConnected = false;
  if (s.deepest < shallowest) shallowest = s.deepest;
  for (let k = 0; k < DUNGEON_SIZE; k++) {
    const edges = [k, (DUNGEON_SIZE - 1) * DUNGEON_SIZE + k, k * DUNGEON_SIZE, k * DUNGEON_SIZE + DUNGEON_SIZE - 1];
    if (edges.some((e) => data[e] === TILE_FLOOR)) edgeFloor = true;
  }
}
ok('the entry tile is floor in every cave', allEntry);
ok('every floor tile is reachable from the entry', allConnected);
ok(`every cave is deep (shallowest deepest point: ${shallowest} steps)`, shallowest >= 40);
ok('no floor on the outer edge, so the torus never joins two sides', !edgeFloor);

const a = dungeonSpec(dungeonWorldId(5006, 4960, 0))!;
const b = dungeonSpec(dungeonWorldId(5006, 4960, 7))!;
ok('copies of one cave share a layout', a.seed === b.seed);
ok(
  'generation is deterministic',
  generateCaves(a.seed, 0, 0).every((v, i) => v === generateCaves(a.seed, 0, 0)[i]),
);
ok('a cave id resolves to a caves world', resolveWorld(a.id)?.generator === 'caves');
ok('malformed cave ids do not resolve', resolveWorld('dungeon:nope') === undefined);

console.log(`\n${failed === 0 ? 'ALL CAVE TESTS PASSED' : `${failed} FAILURE(S)`}`);
process.exit(failed === 0 ? 0 : 1);
