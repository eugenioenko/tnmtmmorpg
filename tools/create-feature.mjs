// Scaffold a new feature folder.
//
//   node tools/create-feature.mjs my-feature
//   node tools/create-feature.mjs my-feature --force   # overwrite an existing folder
//   pnpm create-feature my-feature
//
// Creates features/<name>/{index.ts, client.tsx, README.md} — a server
// plugin skeleton, an optional client skeleton and a README template. The
// folder name is the feature's identity: the server scans features/*/index.ts
// at boot and the client discovers client.tsx via import.meta.glob, so a
// freshly scaffolded feature boots immediately with zero edits.
//
// The name must be lowercase kebab-case or snake_case (letters, digits, '-',
// '_'; no spaces, no leading dash or underscore). Existing folders are never
// touched unless --force is passed.

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo-root features/ directory, resolved from this file's own location so
// the script works no matter which cwd it is invoked from.
const FEATURES_DIR = fileURLToPath(new URL('../features/', import.meta.url));

const USAGE = 'usage: node tools/create-feature.mjs <name> [--force]\n'
  + '  <name>    lowercase kebab-case or snake_case, e.g. my-feature or my_feature';

function fail(message) {
  console.error(`create-feature: ${message}`);
  console.error(USAGE);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { name: undefined, force: false };
  for (const arg of argv) {
    if (arg === '--force') {
      args.force = true;
      continue;
    }
    if (arg.startsWith('-')) {
      fail(`unknown argument '${arg}'`);
    }
    if (args.name !== undefined) {
      fail(`expected a single feature name, got both '${args.name}' and '${arg}'`);
    }
    args.name = arg;
  }
  return args;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

function validateName(name) {
  if (name === undefined) {
    fail('missing feature name');
  }
  if (name !== name.toLowerCase()) {
    fail(`'${name}' must be all lowercase`);
  }
  if (/\s/.test(name)) {
    fail(`'${name}' must not contain spaces`);
  }
  if (!NAME_RE.test(name)) {
    fail(
      `'${name}' is not a valid feature name — use kebab-case or snake_case `
        + `(lowercase letters, digits, '-' and '_', starting with a letter or digit)`,
    );
  }
  if (name === '_example') {
    fail(`'${name}' is the tutorial feature's folder — pick a different name`);
  }
  return name;
}

// ── File templates ─────────────────────────────────────────────────────────
//
// Every skeleton compiles immediately: the server tsconfig typechecks
// features/*/index.ts and the client tsconfig typechecks features/*/client.tsx,
// so a scaffolded feature passes `pnpm typecheck` and `pnpm lint` with zero
// edits. TODO comments mark where each registry entry goes; the commented
// examples are copy-pasteable.

function indexTemplate(name) {
  return `import {
  definePlugin,
  type CommandDef,
  type ItemDef,
  type RecipeDef,
  type SystemDef,
} from '@game/shared';

/**
 * ${name} — one paragraph: what this feature does and why it exists.
 *
 * A feature is one folder: this file (server side), an optional client.tsx
 * (UI panels and sprite glyphs) and a README.md. Nothing outside this folder
 * ever needs to change — the server scans the features folder at boot and the
 * client discovers client.tsx via import.meta.glob.
 *
 * House rules (see CONTRIBUTING.md):
 * - every id you register must be namespaced '${name}:thing';
 * - never mutate another feature's components directly — talk via events or
 *   exported helpers;
 * - use world.rng(), never Math.random (banned by lint);
 * - keep the README in sync.
 */

// ── Items ─────────────────────────────────────────────────────────────────
// { id, name, tags, stack }. Tags are the interop primitive — another
// feature's recipe can consume YOUR items by tag without importing anything
// from you. Example:
//   { id: '${name}:herb', name: 'Mystic Herb', tags: ['herb', 'plant'], stack: 10 },
const ITEMS: ItemDef[] = [
  // TODO: register items here.
];

// ── Recipes ───────────────────────────────────────────────────────────────
// A recipe crafts at a station (an entity kind) from inputs matched by tag
// or exact id. Example:
//   {
//     id: '${name}:potion', station: '${name}:cauldron',
//     inputs: [{ tag: 'herb', count: 2 }],
//     outputs: [{ id: '${name}:potion', count: 1 }],
//     ticks: 30, // 30 ticks = 3 seconds at 10 ticks/sec
//   },
const RECIPES: RecipeDef[] = [
  // TODO: register recipes here.
];

// ── Systems ───────────────────────────────────────────────────────────────
// A system runs every tick with the sanctioned WorldAPI. Example:
//   { name: '${name}:beat', fn: (world) => { world.log('beat'); } },
const SYSTEMS: SystemDef[] = [
  // TODO: register systems here.
];

// ── Commands ──────────────────────────────────────────────────────────────
// A command fires when a client sends an intent with its kind, e.g. a panel
// button sending { t: 'intent', kind: '${name}:wave' }. Example:
//   {
//     name: '${name}:wave',
//     fn: (world, _args, entityId) => { world.log(\`wave from entity \${entityId}\`); },
//   },
const COMMANDS: CommandDef[] = [
  // TODO: register commands here.
];

export default definePlugin({
  id: '${name}',
  items: ITEMS,
  recipes: RECIPES,
  entityKinds: [
    // TODO: register entity kinds here, e.g. '${name}:cauldron' — recipes
    // target a station by its kind, so any kind you craft at must be listed.
  ],
  systems: SYSTEMS,
  commands: COMMANDS,
  events: {
    // TODO: register event listeners here, e.g.
    //   'entity:death': (world, payload) => { world.log(\`\${JSON.stringify(payload)} died\`); },
  },
});
`;
}

function clientTemplate(name) {
  return `import { defineClient, type ItemDef } from '@game/shared';

/**
 * Optional client half of the ${name} feature: item definitions (names for
 * the inventory panel and recipe browser), UI panels (zero-prop React
 * components rendered into the overlay) and sprite glyphs (entity kind ->
 * emoji). Loaded by the client's import.meta.glob at boot — no core client
 * file is touched. Delete this file if the feature needs no client UI.
 */

// Mirror every item you registered server-side so the inventory panel and
// recipe browser can render names. Example:
//   { id: '${name}:herb', name: 'Mystic Herb', tags: ['herb', 'plant'], stack: 10 },
const ITEMS: ItemDef[] = [
  // TODO: register client-side item defs here (copy from index.ts).
];

export default defineClient({
  items: ITEMS,
  // TODO: add UI panels here. A panel is a React component receiving
  // sendIntent; see features/_example/client.tsx for a full example. If you
  // uncomment one, also add \`type Intent\` to the '@game/shared' import:
  //   '${name}:panel': ({ sendIntent }: { sendIntent: (intent: Intent) => void }) => (
  //     <button type="button" onClick={() => sendIntent({ t: 'intent', kind: '${name}:wave' })}>
  //       wave
  //     </button>
  //   ),
  panels: {},
  // TODO: add sprite glyphs here, one emoji per entity kind:
  //   '${name}:cauldron': '🧪',
  sprites: {},
});
`;
}

function readmeTemplate(name) {
  return `# ${name}

## Description

<!-- One paragraph: what does this feature do? Why does it exist? -->

## Items

<!-- List every item this feature registers (id, name, tags, stack). -->

## Recipes

<!-- List every recipe this feature registers (id, station, inputs, outputs, ticks). -->

## Systems

<!-- Describe each system this feature registers and what it does each tick. -->

## Commands

<!-- List every command this feature registers and what it does. -->

Delete sections you don't need.
`;
}

// ── Main ───────────────────────────────────────────────────────────────────

const { name: rawName, force } = parseArgs(process.argv.slice(2));
const name = validateName(rawName);
const dir = join(FEATURES_DIR, name);

if (existsSync(dir)) {
  if (!force) {
    fail(`features/${name} already exists — pass --force to overwrite it`);
  }
  rmSync(dir, { recursive: true, force: true });
}

mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'index.ts'), indexTemplate(name));
writeFileSync(join(dir, 'client.tsx'), clientTemplate(name));
writeFileSync(join(dir, 'README.md'), readmeTemplate(name));

console.log(`Created feature '${name}' at features/${name}/`);
console.log('  index.ts    server plugin skeleton (items, recipes, systems, commands, events)');
console.log('  client.tsx  optional client skeleton (panels, sprites)');
console.log('  README.md   fill this in — every feature ships a README');
