// Reset the world database to a deterministic, seeded state.
//
//   node tools/reset-world.mjs --seed 42 [--db .data/dev.sqlite]
//   node tools/reset-world.mjs --seed 42 --width 500 --height 500
//   pnpm world:reset -- --seed 42
//
// The world is chunk-based and sparse: every chunk is generated
// deterministically from the seed by the layered-noise terrain generator
// (world-chunks.ts) when it is first touched, so an unvisited 10000x10000
// world costs almost nothing. The reset pins the spawn box (tiles 1..18)
// to grass — players always spawn inside it, and the noise terrain can put
// water or mountains anywhere — then flushes so the db starts with exactly
// that state. Running the same args twice produces byte-identical database
// files — reproducible local worlds and replayable bug reports.

import { rmSync } from 'node:fs';
import { openDb } from '../packages/server/src/db.ts';
import { DEFAULT_WORLD_HEIGHT, DEFAULT_WORLD_WIDTH, World } from '../packages/server/src/world.ts';

const DEFAULT_SEED = 42;
const DEFAULT_DB = '.data/dev.sqlite';
// Ensure the centre of the world is walkable: the noise terrain can place
// water or mountains there, and players always spawn near the centre.
const CX = (width / 2) | 0;
const CY = (height / 2) | 0;
const SPAWN_BOX = 18; // tiles CX±9 × CY±9 are forced grass
for (let y = CY - 9; y <= CY + 9; y++) {
  for (let x = CX - 9; x <= CX + 9; x++) {
    world.setTile(x, y, 'grass');
  }
}
db.close();

console.log(`World reset: ${width}x${height} seed ${seed} at ${dbPath}`);
