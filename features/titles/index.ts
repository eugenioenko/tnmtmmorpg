import { definePlugin, isStatsComponent, type EntityState, type WorldAPI } from '@game/shared';

/**
 * Titles: deeds remembered. Each character keeps a tally of what they have
 * done (creatures slain, omens felled, crops harvested, bridges laid, goods
 * delivered and sold...) and earns titles as the tallies grow. One earned
 * title can be worn; it shows over the character's head.
 *
 * Tallies come from other features' events ('bestiary:slain',
 * 'omens:slain', 'farming:harvested', 'bridges:laid', 'bounties:delivered',
 * 'stalls:takings', 'town:quest-complete', 'combat:killed'); levels, trade
 * skills and guild leadership are read off the player's components.
 *
 * `titles:progress` (private) and `titles:worn` (public) are saved with the
 * character.
 */

export type Stat =
  | 'kills'
  | 'wolves'
  | 'hens'
  | 'elites'
  | 'omens'
  | 'level'
  | 'mining'
  | 'woodcutting'
  | 'quests'
  | 'bounty'
  | 'sales'
  | 'bridges'
  | 'harvests'
  | 'guildlead'
  | 'deaths';

export interface TitleDef {
  id: string;
  text: string;
  how: string;
  stat: Stat;
  need: number;
}

export interface Progress {
  counts: Partial<Record<Stat, number>>;
  earned: string[];
}

export interface Worn {
  id: string;
  text: string;
}

export const TITLES: TitleDef[] = [
  { id: 'titles:hunter', text: 'the Hunter', how: 'Slay 50 creatures', stat: 'kills', need: 50 },
  { id: 'titles:relentless', text: 'the Relentless', how: 'Slay 500 creatures', stat: 'kills', need: 500 },
  { id: 'titles:henbane', text: 'Bane of Hens', how: 'Slay 30 hens', stat: 'hens', need: 30 },
  { id: 'titles:wolfbane', text: 'Wolfbane', how: 'Slay 25 wolves', stat: 'wolves', need: 25 },
  { id: 'titles:giantfeller', text: 'Giant-Feller', how: 'Slay an Alpha Wolf or a Snowhorn', stat: 'elites', need: 1 },
  { id: 'titles:omenslayer', text: 'Omenslayer', how: 'Help bring down an omen', stat: 'omens', need: 1 },
  { id: 'titles:omenbane', text: 'Omenbane', how: 'Help bring down 10 omens', stat: 'omens', need: 10 },
  { id: 'titles:seasoned', text: 'the Seasoned', how: 'Reach level 10', stat: 'level', need: 10 },
  { id: 'titles:veteran', text: 'the Veteran', how: 'Reach level 20', stat: 'level', need: 20 },
  { id: 'titles:deepdelver', text: 'Deepdelver', how: 'Reach mining level 10', stat: 'mining', need: 10 },
  { id: 'titles:woodwarden', text: 'Woodwarden', how: 'Reach woodcutting level 10', stat: 'woodcutting', need: 10 },
  { id: 'titles:greenthumb', text: 'Green-Thumbed', how: 'Harvest 25 crops', stat: 'harvests', need: 25 },
  { id: 'titles:bridgewright', text: 'Bridgewright', how: 'Lay 20 walkways', stat: 'bridges', need: 20 },
  { id: 'titles:friend', text: 'Friend of the Village', how: 'Finish 5 village quests', stat: 'quests', need: 5 },
  { id: 'titles:dependable', text: 'the Dependable', how: 'Deliver 25 goods to bounties', stat: 'bounty', need: 25 },
  { id: 'titles:merchant', text: 'the Merchant', how: 'Take 500 gold from your stall’s till', stat: 'sales', need: 500 },
  { id: 'titles:guildmaster', text: 'Guildmaster', how: 'Lead a guild', stat: 'guildlead', need: 1 },
  { id: 'titles:oftfallen', text: 'the Oft-Fallen', how: 'Fall 10 times', stat: 'deaths', need: 10 },
];

const WOLVES = new Set(['wolf', 'alpha', 'frost_wolf']);
const HENS = new Set(['hen', 'drowned_hen']);
const ELITES = new Set(['alpha', 'yeti_ram']);
const LIVE: Stat[] = ['level', 'mining', 'woodcutting', 'guildlead'];

let clock = 0;

function progressOf(e: EntityState | undefined): Progress {
  const p = e?.components['titles:progress'] as Progress | undefined;
  return p && typeof p.counts === 'object' && p.counts !== null && Array.isArray(p.earned) ? p : { counts: {}, earned: [] };
}

function live(e: EntityState, stat: Stat): number {
  if (stat === 'level') return isStatsComponent(e.components.stats) ? e.components.stats.level : 0;
  if (stat === 'mining' || stat === 'woodcutting') {
    const s = e.components['professions:skills'] as Record<string, { level?: unknown }> | undefined;
    const lv = s?.[stat]?.level;
    return typeof lv === 'number' ? lv : 0;
  }
  if (stat === 'guildlead') {
    const r = e.components['guilds:roster'] as { guild?: { me?: unknown } } | undefined;
    return r?.guild?.me === 'leader' ? 1 : 0;
  }
  return 0;
}

/** Record the tallies and hand out any titles they now earn. */
function bump(world: WorldAPI, id: number, add: Partial<Record<Stat, number>>): void {
  const e = world.get(id);
  if (!e || e.kind !== 'player') return;
  const prev = progressOf(e);
  const counts = { ...prev.counts };
  for (const [k, v] of Object.entries(add) as [Stat, number][]) {
    if (LIVE.includes(k)) counts[k] = v > (counts[k] ?? 0) ? v : (counts[k] ?? 0);
    else counts[k] = (counts[k] ?? 0) + v;
  }
  const earned = [...prev.earned];
  const fresh: TitleDef[] = [];
  for (const t of TITLES) {
    if (!earned.includes(t.id) && (counts[t.stat] ?? 0) >= t.need) {
      earned.push(t.id);
      fresh.push(t);
    }
  }
  const next: Progress = { counts, earned };
  if (JSON.stringify(next) === JSON.stringify(prev)) return;
  world.update(id, { 'titles:progress': next });
  for (const t of fresh) {
    world.emit('character:grant', { entityId: id, reason: `🏅 New title: “${t.text}”. Wear it from your titles (H).`, tone: 'level' });
  }
}

function wear(world: WorldAPI, id: number, titleId: unknown): void {
  const e = world.get(id);
  if (!e) return;
  if (titleId === null || titleId === '') {
    world.update(id, { 'titles:worn': undefined });
    return;
  }
  const t = TITLES.find((x) => x.id === titleId);
  if (!t || !progressOf(e).earned.includes(t.id)) return;
  world.update(id, { 'titles:worn': { id: t.id, text: t.text } satisfies Worn });
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

export default definePlugin({
  id: 'titles',
  items: [],
  recipes: [],
  entityKinds: [],
  privateComponents: ['titles:progress'],
  persistComponents: ['titles:progress', 'titles:worn'],

  systems: [
    {
      name: 'titles:live',
      fn: (world) => {
        clock++;
        if (clock % 50 !== 0) return;
        for (const p of world.query('player')) {
          const add: Partial<Record<Stat, number>> = {};
          for (const s of LIVE) add[s] = live(p, s);
          bump(world, p.id, add);
        }
      },
    },
  ],

  commands: [{ name: 'titles:wear', fn: (world, args, id) => wear(world, id, (args as { id?: unknown } | undefined)?.id ?? null) }],

  events: {
    'bestiary:slain': (world, payload) => {
      const ev = payload as { killerId?: unknown; species?: unknown; assist?: unknown };
      if (typeof ev.killerId !== 'number' || ev.assist === true) return;
      const sp = typeof ev.species === 'string' ? ev.species : '';
      bump(world, ev.killerId, { kills: 1, wolves: WOLVES.has(sp) ? 1 : 0, hens: HENS.has(sp) ? 1 : 0, elites: ELITES.has(sp) ? 1 : 0 });
    },
    'omens:slain': (world, payload) => {
      const ev = payload as { entityId?: unknown };
      if (typeof ev.entityId === 'number') bump(world, ev.entityId, { omens: 1 });
    },
    'farming:harvested': (world, payload) => {
      const ev = payload as { entityId?: unknown };
      if (typeof ev.entityId === 'number') bump(world, ev.entityId, { harvests: 1 });
    },
    'bridges:laid': (world, payload) => {
      const ev = payload as { entityId?: unknown };
      if (typeof ev.entityId === 'number') bump(world, ev.entityId, { bridges: 1 });
    },
    'bounties:delivered': (world, payload) => {
      const ev = payload as { entityId?: unknown; count?: unknown };
      if (typeof ev.entityId === 'number') bump(world, ev.entityId, { bounty: num(ev.count) });
    },
    'stalls:takings': (world, payload) => {
      const ev = payload as { entityId?: unknown; gold?: unknown };
      if (typeof ev.entityId === 'number') bump(world, ev.entityId, { sales: num(ev.gold) });
    },
    'town:quest-complete': (world, payload) => {
      const ev = payload as { entityId?: unknown };
      if (typeof ev.entityId === 'number') bump(world, ev.entityId, { quests: 1 });
    },
    'combat:killed': (world, payload) => {
      const ev = payload as { victimId?: unknown; kind?: unknown };
      if (ev.kind === 'player' && typeof ev.victimId === 'number') bump(world, ev.victimId, { deaths: 1 });
    },
  },
});
