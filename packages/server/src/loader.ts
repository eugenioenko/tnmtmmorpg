import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  CommandDef,
  EventHandler,
  ItemDef,
  PluginAPI,
  RecipeDef,
  SystemDef,
} from '@game/shared';

/** Repo-root features/ directory, resolved from this file's own location (cwd-independent). */
const FEATURES_DIR = fileURLToPath(new URL('../../../features/', import.meta.url));

/**
 * Every registered id must be namespaced `feature:thing`. The prefix may be
 * any feature's name (features compose via events, so a listener on a core
 * event like 'entity:death' is legal); the loader's duplicate check is what
 * stops two features from claiming the same id.
 */
const NAMESPACED_ID_RE = /^[A-Za-z0-9_-]+:[A-Za-z0-9_.-]+$/;

export interface LoadedFeature {
  /** plugin.id — the feature's name, e.g. '_example'. */
  name: string;
  /** Absolute path of the feature folder. */
  dir: string;
  plugin: PluginAPI;
}

export interface SystemEntry {
  feature: string;
  name: string;
  fn: SystemDef['fn'];
}

export interface CommandEntry {
  feature: string;
  name: string;
  fn: CommandDef['fn'];
}

export interface EventEntry {
  feature: string;
  event: string;
  fn: EventHandler;
}

/** Everything the runtime needs, merged from every loaded feature. */
export interface Registries {
  items: Map<string, ItemDef>;
  recipes: Map<string, RecipeDef>;
  entityKinds: Set<string>;
  /** Systems in feature-then-declaration order; the tick runs them in this order. */
  systems: SystemEntry[];
  commands: Map<string, CommandEntry>;
  /** Event listeners by event name; several features may listen to one event. */
  events: Map<string, EventEntry[]>;
  /** Components sent only to the entity that owns them. */
  privateComponents: Set<string>;
}

function emptyRegistries(): Registries {
  return {
    items: new Map(),
    recipes: new Map(),
    entityKinds: new Set(),
    systems: [],
    commands: new Map(),
    events: new Map(),
    privateComponents: new Set(),
  };
}

/**
 * Which features to load. FEATURES env is a comma-separated list of feature
 * names; unset or empty means everything. A name that matches no feature
 * folder is a loud boot failure — a typo should never silently load nothing.
 */
function selectFeatures(folderNames: string[]): string[] {
  const raw = process.env.FEATURES;
  if (!raw || raw.trim() === '') return folderNames;
  const wanted = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const missing = wanted.filter((w) => !folderNames.includes(w));
  if (missing.length > 0) {
    throw new Error(
      `[loader] FEATURES='${raw}' lists ${missing.map((m) => `'${m}'`).join(', ')} but no such ` +
        `feature folder exists in ${FEATURES_DIR} (found: ${folderNames.length > 0 ? folderNames.join(', ') : 'none'})`,
    );
  }
  return wanted;
}

/** Pull the plugin object out of a feature module: default export required. */
function requirePlugin(mod: unknown, featureName: string): PluginAPI {
  const candidate = (mod as { default?: unknown }).default ?? mod;
  if (typeof candidate !== 'object' || candidate === null) {
    throw new Error(
      `[loader] feature '${featureName}': index.ts must default-export a plugin object ` +
        '(export default definePlugin({ ... }))',
    );
  }
  const plugin = candidate as Partial<PluginAPI>;
  if (typeof plugin.id !== 'string' || plugin.id.length === 0) {
    throw new Error(`[loader] feature '${featureName}': plugin.id must be a non-empty string`);
  }
  if (plugin.id !== featureName) {
    throw new Error(
      `[loader] feature folder '${featureName}' exports plugin id '${plugin.id}' — they must ` +
        `match: the folder name is the feature's identity (used by FEATURES and log prefixes)`,
    );
  }
  for (const key of ['items', 'recipes', 'entityKinds', 'systems', 'commands'] as const) {
    if (!Array.isArray(plugin[key])) {
      throw new Error(`[loader] feature '${featureName}': plugin.${key} must be an array`);
    }
  }
  if (typeof plugin.events !== 'object' || plugin.events === null) {
    throw new Error(`[loader] feature '${featureName}': plugin.events must be an object`);
  }
  if (plugin.privateComponents !== undefined && !Array.isArray(plugin.privateComponents)) {
    throw new Error(`[loader] feature '${featureName}': plugin.privateComponents must be an array`);
  }
  return plugin as PluginAPI;
}

function checkNamespacedId(feature: string, registry: string, id: string): void {
  if (!NAMESPACED_ID_RE.test(id)) {
    throw new Error(
      `[loader] feature '${feature}' registered ${registry} id '${id}' — ids must be ` +
        `namespaced 'feature:thing' (e.g. '${feature}:wheat')`,
    );
  }
}

/**
 * Register one feature's plugin into the merged registries. Every id goes
 * through a single uniqueness claim: items, entity kinds, systems and
 * commands share one global id space, so a collision anywhere is a loud boot
 * failure naming both claimants. (Event keys are exempt — listening to one
 * event from several features is the point of the bus. Recipe ids are exempt
 * too: a recipe is naturally named after the item it produces, e.g.
 * '_example:glowing_essence' is both a recipe and the item it crafts, so
 * recipe ids only claim uniqueness among recipes.)
 */
function register(registries: Registries, feature: string, plugin: PluginAPI): void {
  const seen = new Map<string, string>(); // id -> registry, within this feature
  const seenRecipes = new Map<string, string>(); // recipe ids: their own namespace
  const claim = (registry: string, id: string, alreadyRegistered: boolean): void => {
    const owner = seen.get(id);
    if (owner) {
      throw new Error(
        `[loader] duplicate id '${id}' in feature '${feature}' — already registered as ${owner}; ` +
          `${registry} also claims it. Every id across all features must be unique.`,
      );
    }
    if (alreadyRegistered) {
      throw new Error(
        `[loader] duplicate id '${id}' — already registered by another feature as ${registry}. ` +
          `Every id across all features must be unique.`,
      );
    }
    seen.set(id, registry);
  };

  for (const item of plugin.items) {
    if (typeof item.id !== 'string') {
      throw new Error(`[loader] feature '${feature}': every item needs an id string`);
    }
    checkNamespacedId(feature, 'item', item.id);
    claim('item', item.id, registries.items.has(item.id));
    registries.items.set(item.id, item);
  }

  for (const recipe of plugin.recipes) {
    if (typeof recipe.id !== 'string') {
      throw new Error(`[loader] feature '${feature}': every recipe needs an id string`);
    }
    if (typeof recipe.station !== 'string' || recipe.station.length === 0) {
      throw new Error(
        `[loader] feature '${feature}': recipe '${recipe.id}' needs a station entity kind string`,
      );
    }
    if (!Array.isArray(recipe.inputs) || !Array.isArray(recipe.outputs)) {
      throw new Error(
        `[loader] feature '${feature}': recipe '${recipe.id}' needs inputs and outputs arrays`,
      );
    }
    if (!Number.isInteger(recipe.ticks) || recipe.ticks <= 0) {
      throw new Error(
        `[loader] feature '${feature}': recipe '${recipe.id}' needs a positive integer ticks`,
      );
    }
    for (const input of recipe.inputs) {
      const hasTag = typeof input.tag === 'string';
      const hasId = typeof input.id === 'string';
      if (hasTag === hasId) {
        throw new Error(
          `[loader] feature '${feature}': recipe '${recipe.id}' input must have exactly one of tag or id`,
        );
      }
      if (!Number.isInteger(input.count) || input.count <= 0) {
        throw new Error(
          `[loader] feature '${feature}': recipe '${recipe.id}' input needs a positive integer count`,
        );
      }
    }
    for (const output of recipe.outputs) {
      if (typeof output.id !== 'string' || output.id.length === 0) {
        throw new Error(
          `[loader] feature '${feature}': recipe '${recipe.id}' output needs an item id string`,
        );
      }
      if (!Number.isInteger(output.count) || output.count <= 0) {
        throw new Error(
          `[loader] feature '${feature}': recipe '${recipe.id}' output needs a positive integer count`,
        );
      }
    }
    checkNamespacedId(feature, 'recipe', recipe.id);
    const owner = seenRecipes.get(recipe.id);
    if (owner) {
      throw new Error(
        `[loader] duplicate recipe id '${recipe.id}' in feature '${feature}' — already registered as a recipe. ` +
          `Every recipe id across all features must be unique.`,
      );
    }
    if (registries.recipes.has(recipe.id)) {
      throw new Error(
        `[loader] duplicate recipe id '${recipe.id}' — already registered by another feature. ` +
          `Every recipe id across all features must be unique.`,
      );
    }
    seenRecipes.set(recipe.id, 'recipe');
    registries.recipes.set(recipe.id, recipe);
  }

  for (const kind of plugin.entityKinds) {
    if (typeof kind !== 'string') {
      throw new Error(`[loader] feature '${feature}': every entity kind must be a string`);
    }
    checkNamespacedId(feature, 'entity kind', kind);
    claim('entity kind', kind, registries.entityKinds.has(kind));
    registries.entityKinds.add(kind);
  }

  for (const system of plugin.systems) {
    if (typeof system.name !== 'string' || typeof system.fn !== 'function') {
      throw new Error(`[loader] feature '${feature}': every system needs a string name and a fn`);
    }
    checkNamespacedId(feature, 'system', system.name);
    claim(
      'system',
      system.name,
      registries.systems.some((s) => s.name === system.name),
    );
    registries.systems.push({ feature, name: system.name, fn: system.fn });
  }

  for (const command of plugin.commands) {
    if (typeof command.name !== 'string' || typeof command.fn !== 'function') {
      throw new Error(`[loader] feature '${feature}': every command needs a string name and a fn`);
    }
    checkNamespacedId(feature, 'command', command.name);
    claim('command', command.name, registries.commands.has(command.name));
    registries.commands.set(command.name, { feature, name: command.name, fn: command.fn });
  }

  for (const [event, handler] of Object.entries(plugin.events)) {
    checkNamespacedId(feature, 'event', event);
    if (typeof handler !== 'function') {
      throw new Error(`[loader] feature '${feature}': event '${event}' needs a handler function`);
    }
    const list = registries.events.get(event);
    const entry: EventEntry = { feature, event, fn: handler };
    if (list) list.push(entry);
    else registries.events.set(event, [entry]);
  }

  for (const name of plugin.privateComponents ?? []) {
    if (typeof name !== 'string') {
      throw new Error(`[loader] feature '${feature}': every private component must be a string`);
    }
    checkNamespacedId(feature, 'private component', name);
    registries.privateComponents.add(name);
  }
}

/**
 * Scan the features directory (features/<name>/index.ts) and load every
 * feature (or the FEATURES-env subset) into merged registries. Any
 * validation failure throws here, so a broken feature stops the boot loudly
 * instead of half-starting.
 */
export async function loadFeatures(): Promise<{
  features: LoadedFeature[];
  registries: Registries;
}> {
  const registries = emptyRegistries();

  if (!existsSync(FEATURES_DIR)) {
    console.warn(`[loader] no features directory at ${FEATURES_DIR} — booting with zero features`);
    return { features: [], registries };
  }

  const folderNames = readdirSync(FEATURES_DIR)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => statSync(join(FEATURES_DIR, name)).isDirectory())
    .filter((name) => existsSync(join(FEATURES_DIR, name, 'index.ts')))
    .sort();

  const wanted = selectFeatures(folderNames);
  const features: LoadedFeature[] = [];

  for (const name of wanted) {
    const entry = join(FEATURES_DIR, name, 'index.ts');
    const mod = await import(pathToFileURL(entry).href);
    const plugin = requirePlugin(mod, name);
    register(registries, name, plugin);
    features.push({ name, dir: join(FEATURES_DIR, name), plugin });
    console.log(
      `[loader] feature '${name}' registered: ${plugin.items.length} item(s), ` +
        `${plugin.recipes.length} recipe(s), ${plugin.entityKinds.length} kind(s), ` +
        `${plugin.systems.length} system(s), ${plugin.commands.length} command(s), ` +
        `${Object.keys(plugin.events).length} event listener(s)`,
    );
  }

  return { features, registries };
}
