// Reset the world database to a deterministic, seeded state.
//
//   node tools/reset-world.mjs --seed 42 [--db .data/dev.sqlite]
//   node tools/reset-world.mjs --seed 42 --width 500 --height 500
//   pnpm world:reset -- --seed 42
//
// The world is chunk-based and sparse: only the border-wall chunks and the
// scatter area near the origin (0..200 tiles) are generated and persisted.
// Everything else is grass, generated identically on demand from the seed
// when players explore it. Running the same args twice produces byte-
// identical database files — reproducible local worlds and replayable bug
// reports.

import { rmSync } from 'node:fs';
import { openDb } from '../packages/server/src/db.ts';
import {
  CHUNK_SHIFT,
  DEFAULT_WORLD_HEIGHT,
  DEFAULT_WORLD_WIDTH,
  World,
} from '../packages/server/src/world.ts';

const DEFAULT_SEED = 12345;
const DEFAULT_DB = '.data/dev.sqlite';
const SCATTER_TILES = 200; // pre-generated area around the origin, in tiles

function parseArgs(argv) {
  const args = {
    seed: DEFAULT_SEED,
    db: DEFAULT_DB,
    width: DEFAULT_WORLD_WIDTH,
    height: DEFAULT_WORLD_HEIGHT,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') continue; // pnpm forwards '--' from `pnpm world:reset -- --seed 42`
    const match = /^--(seed|db|width|height)(?:=(.*))?$/.exec(argv[i]);
    if (!match) {
      console.error(`world:reset: unknown argument '${argv[i]}'`);
      process.exit(1);
    }
    const value = match[2] ?? argv[++i];
    if (value === undefined) {
      console.error(`world:reset: --${match[1]} needs a value`);
      process.exit(1);
    }
    if (match[1] === 'seed') args.seed = Number(value);
    else if (match[1] === 'db') args.db = value;
    else if (match[1] === 'width') args.width = Number(value);
    else args.height = Number(value);
  }
  return args;
}

const { seed, db: dbPath, width, height } = parseArgs(process.argv.slice(2));

if (
  !Number.isInteger(seed) ||
  !Number.isInteger(width) ||
  !Number.isInteger(height) ||
  width < 3 ||
  height < 3
) {
  console.error('world:reset: --seed/--width/--height must be integers and the world at least 3x3');
  process.exit(1);
}

// Wipe any previous world, including sqlite sidecar files from a crash.
for (const suffix of ['', '-wal', '-shm', '-journal']) {
  rmSync(dbPath + suffix, { force: true });
}

const db = openDb(dbPath);
const world = new World(width, height, seed, db);

// Border-wall chunks: every chunk that touches the world edge. The world
// edge reads as 'wall' regardless, but pinning these chunks means the db
// mirrors the world border from the start.
const lastCX = (width - 1) >> CHUNK_SHIFT;
const lastCY = (height - 1) >> CHUNK_SHIFT;
for (let cy = 0; cy <= lastCY; cy++) {
  world.ensureChunk(0, cy);
  if (lastCX > 0) world.ensureChunk(lastCX, cy);
}
for (let cx = 0; cx <= lastCX; cx++) {
  world.ensureChunk(cx, 0);
  if (lastCY > 0) world.ensureChunk(cx, lastCY);
}

// The scatter area near the origin: the spawn zone where the world's wall
// clusters are pre-generated (players spawn inside it). The rest of the
// world generates identically on demand when players explore it.
const scatterCX = (SCATTER_TILES >> CHUNK_SHIFT) < lastCX ? SCATTER_TILES >> CHUNK_SHIFT : lastCX;
const scatterCY = (SCATTER_TILES >> CHUNK_SHIFT) < lastCY ? SCATTER_TILES >> CHUNK_SHIFT : lastCY;
for (let cy = 0; cy <= scatterCY; cy++) {
  for (let cx = 0; cx <= scatterCX; cx++) {
    world.ensureChunk(cx, cy);
  }
}

// Keep the server's fallback spawn tile walkable no matter what the seed says.
world.setTile(1, 1, 'grass');
world.flushDirty(db);
db.close();

console.log(`World reset: ${width}x${height} seed ${seed} at ${dbPath}`);
