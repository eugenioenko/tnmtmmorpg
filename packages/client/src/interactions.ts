import type { EntityState, Interaction } from '@game/shared';
import { isStatsComponent } from '@game/shared';

const byKind = new Map<string, Interaction>();
let carries: (itemId: string) => boolean = () => true;

export function registerInteractions(map: Record<string, Interaction>): void {
  for (const [kind, interaction] of Object.entries(map)) byKind.set(kind, interaction);
}

/** How `requires` is checked: does the local player carry this item? */
export function setCarryCheck(check: (itemId: string) => boolean): void {
  carries = check;
}

function isInteraction(value: unknown): value is Interaction {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.intent === 'string' && typeof v.label === 'string';
}

/** What a click on this entity means for the local player. */
export type EntityAction =
  | { type: 'interact'; interaction: Interaction }
  | { type: 'attack' }
  | { type: 'pickup' }
  | { type: 'none' };

export function actionFor(entity: EntityState, localId: number | null): EntityAction {
  if (entity.id === localId) return { type: 'none' };
  const own = entity.components.interact;
  if (isInteraction(own)) return { type: 'interact', interaction: own };
  const declared = byKind.get(entity.kind);
  if (declared && (!declared.requires || carries(declared.requires))) {
    return { type: 'interact', interaction: declared };
  }
  if (entity.kind === 'item') return { type: 'pickup' };
  if (entity.kind !== 'player' && isStatsComponent(entity.components.stats)) {
    return { type: 'attack' };
  }
  return { type: 'none' };
}

/** Human name for tooltips and frames. */
export function entityName(entity: EntityState): string {
  const label = entity.components.label;
  if (typeof label === 'string' && label.length > 0) return label.replace(/ · .*$/, '');
  const name = entity.components.name;
  if (typeof name === 'string' && name.length > 0) return name;
  const character = entity.components.character as { name?: unknown } | undefined;
  if (typeof character?.name === 'string') return character.name;
  if (entity.kind === 'player') return `Wanderer ${entity.id}`;
  if (entity.kind === 'npc') return 'Villager';
  const bare = entity.kind.includes(':') ? entity.kind.split(':')[1] : entity.kind;
  return bare.charAt(0).toUpperCase() + bare.slice(1).replace(/[_-]/g, ' ');
}
