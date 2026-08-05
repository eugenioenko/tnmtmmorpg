// Headless fake players — test the multiplayer server alone.
//
//   node tools/bot.mjs --count 2 --url ws://localhost:3010
//   pnpm bot -- --count 2
//
// Each bot connects exactly like a browser player (welcome -> recipes ->
// full/delta snapshots -> intents), then plays a simple state machine:
//
//   WANDER  — every 2-5 seconds pick a direction (wall-aware via the tile
//             map accumulated from full/delta messages) and send a move intent
//   PICKUP  — when standing on a ground item, send a pickup intent
//   CRAFT   — when adjacent to a station, craft the first recipe for that
//             station whose inputs it can fully verify from its inventory
//   SETUP   — once, shortly after connect: ask the tutorial feature for
//             starter items and a practice workbench via its own commands
//             (_example:give / _example:station — the exact intents the
//             example panel's buttons send). If _example is not loaded the
//             server rejects them and the bot just wanders.
//
// Crafting is best-effort: recipes with tag-matched inputs are skipped
// (bots cannot see the item registry, only item ids in their inventory).
//
// Ctrl-C disconnects every bot and exits cleanly.

import { WebSocket } from 'ws';

// ── CLI ────────────────────────────────────────────────────────────────────

function usage() {
  return [
    'usage: node tools/bot.mjs [--count N] [--url ws://HOST:PORT] [--seed N]',
    '  --count  number of bots to spawn (default 1)',
    '  --url    server to connect to (default ws://localhost:3010)',
    '  --seed   rng seed so runs are reproducible (default: current time)',
  ].join('\n');
}

function fail(message) {
  console.error(`bot: ${message}`);
  console.error(usage());
  process.exit(1);
}

function parseArgs(argv) {
  const args = { count: 1, url: 'ws://localhost:3010', seed: Date.now() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue; // pnpm forwards '--' from `pnpm bot -- --count 2`
    const match = /^--(count|url|seed)(?:=(.*))?$/.exec(arg);
    if (!match) fail(`unknown argument '${arg}'`);
    const value = match[2] ?? argv[++i];
    if (value === undefined) fail(`--${match[1]} needs a value`);
    if (match[1] === 'count') {
      const count = Number(value);
      if (!Number.isInteger(count) || count < 1) {
        fail(`--count must be a positive integer, got '${value}'`);
      }
      args.count = count;
    } else if (match[1] === 'url') {
      if (!/^wss?:\/\//.test(value)) fail(`--url must start with ws:// or wss://, got '${value}'`);
      args.url = value;
    } else {
      args.seed = Number(value);
    }
  }
  return args;
}

// ── Seeded rng (Math.random is banned in this repo; a tool script gets the
//    same treatment so runs are reproducible with --seed) ────────────────

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIRECTIONS = ['n', 's', 'e', 'w'];

const DIR_NAMES = { n: 'north', s: 'south', e: 'east', w: 'west' };

function chebyshev(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

// ── One bot ────────────────────────────────────────────────────────────────

class Bot {
  constructor(index, url, seed) {
    this.index = index;
    this.name = `Bot-${index + 1}`;
    this.url = url;
    this.rng = mulberry32((seed ^ (index * 0x9e3779b9)) >>> 0);

    this.socket = null;
    this.entityId = null;
    this.recipes = [];
    this.recipesByStation = new Map(); // station kind -> recipe ids
    this.tiles = new Map(); // "x,y" -> tile kind
    this.entities = []; // latest snapshot entities
    this.self = null; // own entity from the latest snapshot
    this.inventory = new Map(); // itemId -> total count across slots
    this.inventorySlots = [];

    this.nextWanderAt = 0;
    this.pickupCooldownUntil = 0;
    this.craftCooldown = new Map(); // recipeId -> timestamp
    this.setupAt = -1; // performance.now() of the first snapshot
    this.gaveItems = false;
    this.spawnedStation = false;
    this.seenStationKinds = new Set(); // station kinds observed in any snapshot
    this.closedByUs = false;
    this.reportedDisabled = false;
  }

  log(message) {
    console.log(`[${this.name}] ${message}`);
  }

  connect() {
    this.log(`connecting to ${this.url}`);
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.on('open', () => {
      this.log('connected - waiting for welcome');
    });

    socket.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        this.log(`dropped non-JSON message: ${data.toString().slice(0, 80)}`);
        return;
      }
      this.onMessage(message);
    });

    socket.on('error', (err) => {
      this.log(`connection error: ${err.message}`);
      process.exitCode = 1;
      socket.close();
    });

    socket.on('close', () => {
      if (this.closedByUs) return;
      this.log('disconnected (server closed the connection)');
      process.exitCode = 1;
    });
  }

  onMessage(message) {
    switch (message.t) {
      case 'welcome':
        this.entityId = message.entityId;
        this.log(`connected as entity ${message.entityId} (color ${message.color})`);
        break;

      case 'recipes':
        this.recipes = message.recipes ?? [];
        for (const recipe of this.recipes) {
          const ids = this.recipesByStation.get(recipe.station) ?? [];
          ids.push(recipe);
          this.recipesByStation.set(recipe.station, ids);
        }
        this.log(`received ${this.recipes.length} recipe(s)`);
        break;

      case 'full':
        this.onFull(message);
        break;

      case 'delta':
        this.onDelta(message);
        break;

      default:
        // pong etc.: nothing the bot needs
        break;
    }
  }

  /** The first world message is always a full: it replaces the accumulated model. */
  onFull(snapshot) {
    if (this.setupAt === -1) {
      this.setupAt = performance.now();
      this.nextWanderAt = this.setupAt + 500;
      this.log(`ready at tick ${snapshot.tick} - ${snapshot.entities.length} entit(y/ies)`);
    }

    this.tiles = new Map();
    for (const tile of snapshot.tiles) this.tiles.set(`${tile.x},${tile.y}`, tile.kind);
    this.entities = snapshot.entities;
    this.afterWorldUpdate(snapshot);
  }

  /** Deltas patch the accumulated model on top of what the client already knows. */
  onDelta(delta) {
    if (this.setupAt === -1) return; // the first world message is always a full

    for (const id of delta.removedEntities ?? []) {
      this.entities = this.entities.filter((e) => e.id !== id);
    }
    const byId = new Map(this.entities.map((e) => [e.id, e]));
    for (const entity of delta.entities ?? []) byId.set(entity.id, entity);
    this.entities = [...byId.values()];
    for (const tile of delta.tiles ?? []) this.tiles.set(`${tile.x},${tile.y}`, tile.kind);
    for (const tile of delta.removedTiles ?? []) this.tiles.delete(`${tile.x},${tile.y}`);

    this.afterWorldUpdate(delta);
  }

  /** Shared tail of full/delta handling: refresh self + inventory, then act. */
  afterWorldUpdate(msg) {
    this.self = this.entities.find((e) => e.id === this.entityId) ?? null;

    if (msg.disabledFeatures && !this.reportedDisabled) {
      this.reportedDisabled = true;
      this.log(`server auto-disabled feature(s): ${msg.disabledFeatures.join(', ')}`);
    }

    if (!this.self) return; // despawned between ticks — nothing to do

    // Inventory view: recompute from the authoritative state every message.
    const inv = this.self.components?.inventory;
    this.inventory = new Map();
    this.inventorySlots = [];
    if (inv && Array.isArray(inv.slots)) {
      this.inventorySlots = inv.slots;
      for (const slot of inv.slots) {
        if (typeof slot?.itemId === 'string' && slot.itemId !== '') {
          this.inventory.set(slot.itemId, (this.inventory.get(slot.itemId) ?? 0) + slot.count);
        }
      }
    }

    const now = performance.now();
    this.decide(now);
  }

  // ── the state machine ────────────────────────────────────────────────────

  decide(now) {
    const stationKinds = new Set(this.recipesByStation.keys());
    for (const entity of this.entities) {
      if (stationKinds.has(entity.kind)) this.seenStationKinds.add(entity.kind);
    }

    // PICKUP: stand on a ground item -> pick it up.
    const ground = this.entities.find(
      (e) => e.kind === 'item' && e.x === this.self.x && e.y === this.self.y,
    );
    if (ground && now >= this.pickupCooldownUntil) {
      this.pickupCooldownUntil = now + 800;
      const drop = ground.components?.itemDrop;
      const itemId = typeof drop?.itemId === 'string' ? drop.itemId : '?';
      this.send({ t: 'intent', kind: 'pickup' });
      this.log(`pickup ${itemId}`);
      return;
    }

    // CRAFT: adjacent to a station with a recipe the bot can fully verify.
    const adjacentStation = this.entities.find((e) => {
      if (!stationKinds.has(e.kind)) return false;
      return chebyshev(e, this.self) <= 1;
    });
    if (adjacentStation) {
      const recipe = this.pickRecipe(adjacentStation.kind);
      if (recipe && now >= (this.craftCooldown.get(recipe.id) ?? 0)) {
        this.craftCooldown.set(recipe.id, now + 4000);
        this.send({ t: 'intent', kind: 'craft', recipeId: recipe.id, stationEntityId: adjacentStation.id });
        this.log(`craft ${recipe.id} at station #${adjacentStation.id}`);
        return;
      }
    }

    // SETUP: once, a couple of seconds in — starter items, and a practice
    // workbench if the world has none. These are the tutorial feature's own
    // commands; if _example is not loaded the server logs and rejects them.
    if (now - this.setupAt > 1000 && !this.gaveItems) {
      this.gaveItems = true;
      this.send({ t: 'intent', kind: '_example:give', item: '_example:stone', count: 25 });
      this.log("setup: asked for 25 '_example:stone' (_example:give)");
    }
    if (now - this.setupAt > 2500 && !this.spawnedStation && this.seenStationKinds.size === 0) {
      this.spawnedStation = true;
      this.send({ t: 'intent', kind: '_example:station' });
      this.log('setup: no station in the world - spawned a practice workbench (_example:station)');
    }

    // WANDER: every 2-5 seconds, move toward a station if one exists, else
    // pick a random direction; skip tiles the snapshot says are walls.
    if (now >= this.nextWanderAt) {
      const dir = this.chooseMove();
      this.nextWanderAt = now + 2000 + this.rng() * 3000;
      if (dir) {
        this.send({ t: 'intent', kind: 'move', dir });
        this.log(`move ${DIR_NAMES[dir]}`);
      } else {
        this.log('nowhere to go - all four tiles are walls');
      }
    }
  }

  /** A recipe for `stationKind` whose inputs are all exact ids the bot holds. */
  pickRecipe(stationKind) {
    const candidates = this.recipesByStation.get(stationKind) ?? [];
    for (const recipe of candidates) {
      const satisfiable = recipe.inputs.every((input) => {
        if (typeof input.id !== 'string') return false; // tag input: cannot verify
        return (this.inventory.get(input.id) ?? 0) >= input.count;
      });
      if (satisfiable) return recipe;
    }
    return null;
  }

  /**
   * Walkable = not a wall in the latest snapshot. Snapshots are sparse:
   * only non-grass tiles are listed, so anything unseen is grass — and the
   * world edge is always listed as wall, so borders stay blocked.
   */
  walkable(x, y) {
    return (this.tiles.get(`${x},${y}`) ?? 'grass') !== 'wall';
  }

  chooseMove() {
    // Prefer the nearest station: move along the axis with the bigger gap.
    const stationKinds = new Set(this.recipesByStation.keys());
    let target = null;
    let targetDist = Infinity;
    for (const entity of this.entities) {
      if (!stationKinds.has(entity.kind)) continue;
      const d = chebyshev(entity, this.self);
      if (d > 1 && d < targetDist) {
        target = entity;
        targetDist = d;
      }
    }

    if (target) {
      const dx = target.x - this.self.x;
      const dy = target.y - this.self.y;
      const axis = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'e' : 'w') : dy > 0 ? 's' : 'n';
      const delta = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] }[axis];
      if (this.walkable(this.self.x + delta[0], this.self.y + delta[1])) return axis;
    }

    // Random walk with wall avoidance: shuffle and take the first free tile.
    const dirs = [...DIRECTIONS];
    for (let i = dirs.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
    }
    const delta = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };
    for (const dir of dirs) {
      const d = delta[dir];
      if (this.walkable(this.self.x + d[0], this.self.y + d[1])) return dir;
    }
    return null;
  }

  send(intent) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(intent));
    }
  }

  close() {
    this.closedByUs = true;
    this.socket?.close();
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

const { count, url, seed } = parseArgs(process.argv.slice(2));

console.log(`[bot] starting ${count} bot(s) against ${url} (seed ${seed})`);

const bots = [];
for (let i = 0; i < count; i++) {
  const bot = new Bot(i, url, seed);
  bots.push(bot);
  bot.connect();
}

let exiting = false;
process.on('SIGINT', () => {
  if (exiting) return;
  exiting = true;
  console.log(`\n[bot] SIGINT - disconnecting ${bots.length} bot(s)`);
  for (const bot of bots) bot.close();
  process.exit(0);
});
