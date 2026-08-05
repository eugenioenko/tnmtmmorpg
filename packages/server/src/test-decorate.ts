/**
 * decorateChunk: the extension point features use to scatter content across
 * newly-generated ground (see features/nature).
 *
 * The three properties that matter, and the ways each has already been got
 * wrong in this repo:
 *   - ONE-SHOT ACROSS RESTARTS. A chunk regenerated after a reboot must not
 *     be decorated again, or every restart grows a fresh crop of trees. This
 *     holds only because a generated chunk is persisted unconditionally, so
 *     "is it in the db" means "has it been generated before".
 *   - DETERMINISM. Contents must depend on the world seed, never on the
 *     order players happened to explore in. That rules out world.rng(), a
 *     single shared sequence; core passes a per-chunk seeded rng instead.
 *   - OFF THE READ PATH. Chunks generate lazily inside world.tile(), which
 *     snapshot building calls, so decoration is queued and drained by the
 *     tick loop rather than run where the chunk was born.
 */

import { rmSync } from 'node:fs';
import { loadAll, loadChunks, openDb } from './db.ts';
import { EventBus } from './events.ts';
import { CHUNK_SIZE, World } from './world.ts';
import { createWorldApi } from './world-api.ts';
import type { ChunkArea, WorldAPI } from '@game/shared';

const DB = '/tmp/test-decorate.sqlite';
let failed = 0;

function ok(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok - ${label}`);
  } else {
    failed++;
    console.log(`  NOT OK - ${label}`);
  }
}

function apiFor(world: World): WorldAPI {
  return createWorldApi({
    world,
    bus: new EventBus(),
    items: new Map(),
    recipes: new Map(),
    log: () => {},
  });
}

/** The per-chunk rng core builds; mirrored here so the test pins the contract. */
function chunkRng(seed: number, cx: number, cy: number): () => number {
  let s = (((seed ^ (cx * 374761393 + cy * 668265263)) >>> 0) || 1) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Drain fresh chunks and run `hook` over each, as the tick loop does. */
function decorate(
  world: World,
  seed: number,
  hook: (world: WorldAPI, area: ChunkArea, rng: () => number) => void,
): number {
  let count = 0;
  for (const { cx, cy } of world.drainFreshChunks()) {
    if (!world.claimChunkDecoration(cx, cy)) continue;
    hook(
      apiFor(world),
      {
        cx,
        cy,
        minX: cx * CHUNK_SIZE,
        minY: cy * CHUNK_SIZE,
        maxX: cx * CHUNK_SIZE + CHUNK_SIZE - 1,
        maxY: cy * CHUNK_SIZE + CHUNK_SIZE - 1,
      },
      chunkRng(seed, cx, cy),
    );
    count++;
  }
  return count;
}

/** A decorator that drops one marker per chunk, at a seeded offset. */
const marker = (world: WorldAPI, area: ChunkArea, rng: () => number): void => {
  const x = area.minX + ~~(rng() * (area.maxX - area.minX + 1));
  const y = area.minY + ~~(rng() * (area.maxY - area.minY + 1));
  world.spawn('test:marker', { x, y });
};

const markers = (w: World): number => w.all().filter((e) => e.kind === 'test:marker').length;

console.log('unit: decorateChunk');

// Fires once per newly generated chunk, and not for chunks already resident.
{
  const w = new World(1000, 1000, 7);
  w.tile(100, 100);
  ok('a generated chunk is offered for decoration', decorate(w, 7, marker) === 1);
  w.tile(101, 101); // same chunk
  ok('the same chunk is not offered twice', decorate(w, 7, marker) === 0);
  ok('one marker spawned', markers(w) === 1);
}

// Determinism: identical output regardless of the order chunks are visited.
{
  const visit = (order: 'fwd' | 'rev'): string => {
    const w = new World(1000, 1000, 7);
    const pts: [number, number][] = [
      [100, 100],
      [400, 700],
      [800, 200],
    ];
    for (const [x, y] of order === 'fwd' ? pts : [...pts].reverse()) w.tile(x, y);
    decorate(w, 7, marker);
    return w
      .all()
      .filter((e) => e.kind === 'test:marker')
      .map((e) => `${e.x},${e.y}`)
      .sort()
      .join('|');
  };
  const fwd = visit('fwd');
  ok('decoration is independent of exploration order', fwd === visit('rev') && fwd.length > 0);
}

{
  const seedA = new World(1000, 1000, 7);
  seedA.tile(100, 100);
  decorate(seedA, 7, marker);
  const seedB = new World(1000, 1000, 99);
  seedB.tile(100, 100);
  decorate(seedB, 99, marker);
  const at = (w: World): string => {
    const m = w.all().find((e) => e.kind === 'test:marker');
    return m ? `${m.x},${m.y}` : '';
  };
  ok('a different seed decorates differently', at(seedA) !== at(seedB));
}

// The regression that matters: a restart must not re-decorate.
{
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(DB + suffix, { force: true });

  const db1 = openDb(DB);
  const w1 = new World(1000, 1000, 7, db1);
  w1.tile(100, 100);
  w1.tile(700, 400);
  decorate(w1, 7, marker);
  const before = markers(w1);
  w1.flushDirty(db1);
  db1.close();
  ok('first boot decorated both chunks', before === 2);

  const db2 = openDb(DB);
  const w2 = new World(1000, 1000, 7, db2);
  const { entities } = loadAll(db2);
  w2.loadFromRows(entities);
  w2.loadChunks(loadChunks(db2));
  w2.tile(100, 100); // revisit the same ground
  w2.tile(700, 400);
  const again = decorate(w2, 7, marker);
  const after = markers(w2);
  db2.close();
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(DB + suffix, { force: true });

  ok('a restored chunk is never offered again', again === 0);
  ok('a restart does not duplicate decoration', after === before);
}

// A generated chunk must persist even when it holds no non-grass tile: that
// equivalence is what makes the restart guarantee above hold.
{
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(DB + suffix, { force: true });
  const db = openDb(DB);
  const w = new World(1000, 1000, 7, db);
  w.tile(100, 100);
  const stored = loadChunks(db).size;
  db.close();
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(DB + suffix, { force: true });
  ok('a freshly generated chunk is persisted', stored === 1);
}

console.log(`\n${failed === 0 ? 'ALL DECORATE-CHUNK TESTS PASSED' : `${failed} FAILURE(S)`}`);
process.exit(failed === 0 ? 0 : 1);
