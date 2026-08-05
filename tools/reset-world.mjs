// Reset the world database to a deterministic, seeded state.
//
//   node tools/reset-world.mjs --seed 42 [--db .data/dev.sqlite]
//   node tools/reset-world.mjs --seed 42 --width 500 --height 500
//   pnpm world:reset -- --seed 42
//
// The world is chunk-based and sparse: every chunk is generated
// deterministically from the seed by the layered-noise terrain generator
// (world-chunks.ts) when it is first touched, so an unvisited 10000x10000
// world costs almost nothing. The reset pins a grass box at the world centre
// so players always spawn on walkable ground. Running the same args twice
// produces byte-identical database files.

import { rmSync } from 'node:fs';
import { getSet, openDb } from '../packages/server/src/db.ts';
import { DEFAULT_WORLD_HEIGHT, DEFAULT_WORLD_WIDTH, World } from '../packages/server/src/world.ts';

const DEFAULT_SEED = 42;
const DEFAULT_DB = '.data/dev.sqlite';

function parseArgs(argv) {
  const args = {
    seed: DEFAULT_SEED,
    db: DEFAULT_DB,
    width: DEFAULT_WORLD_WIDTH,
    height: DEFAULT_WORLD_HEIGHT,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') continue;
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

// Ensure the centre of the world is walkable: the noise terrain can place
// water or mountains there, and players always spawn near the centre.
const CX = (width / 2) | 0;
const CY = (height / 2) | 0;
const BOX = 9; // tiles CX±9 × CY±9 forced to grass
for (let y = CY - BOX; y <= CY + BOX; y++) {
  for (let x = CX - BOX; x <= CX + BOX; x++) {
    world.setTile(x, y, 'grass');
  }
}

// Scatter decorative bushes and trees near the centre (within 200 tiles),
// so the world reads "lived in" from the first moment. Seeded via
// world.rng(), so the same seed always scatters the same population.
let decorated = 0;
for (let attempt = 0; attempt < 500; attempt++) {
  const x = CX - 200 + ~~(world.rng() * 400);
  const y = CY - 200 + ~~(world.rng() * 400);
  if (world.isWalkable(x, y) && world.tile(x, y) !== 'dirt') {
    const kind = world.rng() > 0.7 ? 'tree' : 'bush';
    world.spawn(`nature:${kind}`, { x, y });
    decorated++;
  }
}

// The nature feature (features/nature) scatters its own population on first
// boot, guarded by the kv flag 'nature:seeded'. This world is already
// decorated, so claim the flag here to keep the two mechanisms from
// double-seeding.
getSet(db, 'nature:seeded', '1');

world.flushDirty(db);

db.close();

console.log(
  `World reset: ${width}x${height} seed ${seed} at ${dbPath} ` +
    `(${decorated} bushes/trees scattered near the centre)`,
);
