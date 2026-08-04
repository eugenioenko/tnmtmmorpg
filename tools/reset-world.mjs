// Reset the world database to a deterministic, seeded state.
//
//   node tools/reset-world.mjs --seed 42 [--db .data/dev.sqlite]
//   pnpm world:reset -- --seed 42
//
// The map (grass interior, wall border, seeded wall clusters) is generated
// from the seed, so running the same seed twice produces byte-identical
// database files — reproducible local worlds and replayable bug reports.

import { rmSync } from 'node:fs';
import { openDb, saveTile } from '../packages/server/src/db.ts';
import {
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  TILE_CHUNK,
  World,
} from '../packages/server/src/world.ts';

const DEFAULT_SEED = 12345;
const DEFAULT_DB = '.data/dev.sqlite';

function parseArgs(argv) {
  const args = { seed: DEFAULT_SEED, db: DEFAULT_DB };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') continue; // pnpm forwards '--' from `pnpm world:reset -- --seed 42`
    const match = /^--(seed|db)(?:=(.*))?$/.exec(argv[i]);
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
    else args.db = value;
  }
  return args;
}

const { seed, db: dbPath } = parseArgs(process.argv.slice(2));

// Wipe any previous world, including sqlite sidecar files from a crash.
for (const suffix of ['', '-wal', '-shm', '-journal']) {
  rmSync(dbPath + suffix, { force: true });
}

const db = openDb(dbPath);
const world = new World(DEFAULT_WIDTH, DEFAULT_HEIGHT, seed);

// Scatter a few wall clusters so the map is not just a bordered box.
// The World's seeded rng() makes the layout fully deterministic.
const clusters = 5;
for (let c = 0; c < clusters; c++) {
  const cx = 2 + Math.floor(world.rng() * (world.width - 4));
  const cy = 2 + Math.floor(world.rng() * (world.height - 4));
  const size = 1 + Math.floor(world.rng() * 2); // 1-2 tile radius
  for (let dy = -1; dy <= size; dy++) {
    for (let dx = -1; dx <= size; dx++) {
      world.setTile(cx + dx, cy + dy, 'wall');
    }
  }
}
// Keep the server's fallback spawn tile walkable no matter what the seed says.
world.setTile(1, 1, 'grass');

saveTile(db, TILE_CHUNK, world.tilesToBlob());
db.close();

console.log(`World reset with seed ${seed} at ${dbPath}`);
