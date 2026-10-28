import { definePlugin, type EntityState, type WorldAPI } from '@game/shared';

/**
 * Guilds: lasting companies of adventurers. Founding one costs FOUND_COST
 * gold and a unique name and tag; the tag is worn over every member's head.
 * Ranks are leader, officer and member: officers invite, kick members and
 * set the message of the day; the leader also promotes, demotes and can
 * hand the guild over. A leader who leaves passes it to the senior officer
 * (or the longest-standing member); the last one out disbands it.
 *
 * Guilds are keyed by character name and kept in the persistent kv store
 * (`guilds:data`), so they survive restarts and members being offline.
 * Pending invites are process-local and short-lived.
 *
 * Each player carries a public `guilds:tag` (for the nameplate) and a
 * private `guilds:roster` (for the window). Guild chat and the slash
 * commands come in through chat's 'chat:register-commands' offer.
 */

export type Rank = 'leader' | 'officer' | 'member';

export interface Member {
  name: string;
  rank: Rank;
  joined: number;
  level?: number;
  seen?: number;
}

export interface Guild {
  id: number;
  name: string;
  tag: string;
  motd: string;
  founded: number;
  members: Member[];
}

interface Store {
  seq: number;
  guilds: Guild[];
}

export interface GuildTag {
  tag: string;
  name: string;
}

export interface RosterMember extends Member {
  online: boolean;
}

export interface Roster {
  guild?: Omit<Guild, 'members'> & { members: RosterMember[]; me: Rank };
  invite?: { name: string; tag: string; from: string };
}

interface ChatOffer {
  register(names: string[], help: string, fn: (world: WorldAPI, me: EntityState, rest: string) => void): void;
  deliver(world: WorldAPI, toId: number, line: { ch: string; from?: string; fromId?: number; text: string }): void;
}

export const FOUND_COST = 100;
export const MAX_MEMBERS = 50;
export const MAX_MOTD = 140;
const INVITE_MS = 90_000;
const KEY = 'guilds:data';
const HELP =
  'Guilds: /gc message (guild chat), /ginvite Name, /gaccept, /gdecline, /gleave, /gkick Name, /gpromote Name, /gdemote Name, /gmotd text. U opens the guild window.';

let store: Store | undefined;
let chat: ChatOffer | undefined;
let clock = 0;
const invites = new Map<string, { guildId: number; from: string; at: number }>();
const greeted = new Set<string>();

const key = (name: string): string => name.toLowerCase();
const RANK_ORDER: Record<Rank, number> = { leader: 0, officer: 1, member: 2 };

function load(world: WorldAPI): Store {
  if (store) return store;
  try {
    const raw = world.getSet(KEY);
    const parsed = raw ? (JSON.parse(raw) as Store) : undefined;
    store = parsed && Array.isArray(parsed.guilds) && typeof parsed.seq === 'number' ? parsed : { seq: 0, guilds: [] };
  } catch {
    store = { seq: 0, guilds: [] };
  }
  return store;
}

function persist(world: WorldAPI): void {
  if (store) world.getSet(KEY, JSON.stringify(store));
}

function nameOf(e: EntityState | undefined): string | undefined {
  const c = e?.components.character as { name?: unknown } | undefined;
  return typeof c?.name === 'string' ? c.name : undefined;
}

function levelOf(e: EntityState | undefined): number | undefined {
  const s = e?.components.stats as { level?: unknown } | undefined;
  return typeof s?.level === 'number' ? s.level : undefined;
}

function goldOf(e: EntityState | undefined): number {
  const c = e?.components.character as { gold?: unknown } | undefined;
  return typeof c?.gold === 'number' ? c.gold : 0;
}

function online(world: WorldAPI): Map<string, EntityState> {
  const out = new Map<string, EntityState>();
  for (const p of world.query('player')) {
    const n = nameOf(p);
    if (n) out.set(key(n), p);
  }
  return out;
}

function guildOf(world: WorldAPI, name: string): Guild | undefined {
  return load(world).guilds.find((g) => g.members.some((m) => key(m.name) === key(name)));
}

function memberOf(g: Guild, name: string): Member | undefined {
  return g.members.find((m) => key(m.name) === key(name));
}

function tell(world: WorldAPI, id: number, text: string): void {
  if (chat) chat.deliver(world, id, { ch: 'guild', text });
  else world.emit('character:grant', { entityId: id, reason: text });
}

function tellGuild(world: WorldAPI, g: Guild, text: string): void {
  const on = online(world);
  for (const m of g.members) {
    const e = on.get(key(m.name));
    if (e) tell(world, e.id, text);
  }
}

function sort(g: Guild): void {
  g.members.sort((a, b) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank] || a.joined - b.joined);
}

export function cleanGuildName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[^\p{L}\p{N} '-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 24);
}

export function cleanTag(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 4);
}

function found(world: WorldAPI, me: EntityState, rawName: unknown, rawTag: unknown): void {
  const name = nameOf(me);
  if (!name) return;
  if (guildOf(world, name)) return tell(world, me.id, 'You are already in a guild.');
  const gname = cleanGuildName(rawName);
  const tag = cleanTag(rawTag);
  if (gname.length < 3) return tell(world, me.id, 'A guild name needs at least 3 letters.');
  if (tag.length < 2) return tell(world, me.id, 'A guild tag is 2 to 4 letters or digits.');
  const s = load(world);
  if (s.guilds.some((g) => key(g.name) === key(gname))) return tell(world, me.id, `There is already a guild called ${gname}.`);
  if (s.guilds.some((g) => g.tag === tag)) return tell(world, me.id, `The tag <${tag}> is taken.`);
  if (goldOf(me) < FOUND_COST) return tell(world, me.id, `Founding a guild costs ${FOUND_COST} gold.`);
  world.emit('character:charge', {
    entityId: me.id,
    gold: FOUND_COST,
    then: (w: WorldAPI, ok: boolean) => {
      if (!ok) return tell(w, me.id, `Founding a guild costs ${FOUND_COST} gold.`);
      const st = load(w);
      if (guildOf(w, name) || st.guilds.some((g) => key(g.name) === key(gname) || g.tag === tag)) {
        w.emit('character:grant', { entityId: me.id, gold: FOUND_COST });
        return tell(w, me.id, 'Someone beat you to that name or tag. Your gold is returned.');
      }
      const now = Date.now();
      st.seq += 1;
      st.guilds.push({ id: st.seq, name: gname, tag, motd: '', founded: now, members: [{ name, rank: 'leader', joined: now, level: levelOf(me), seen: now }] });
      persist(w);
      w.emit('character:grant', { entityId: me.id, reason: `You found the guild <${tag}> ${gname}. /ginvite Name to recruit.`, tone: 'level' });
      for (const p of w.query('player')) if (p.id !== me.id) w.emit('character:grant', { entityId: p.id, reason: `🛡 ${name} founded the guild <${tag}> ${gname}.` });
      w.log(`guild #${st.seq} <${tag}> ${gname} founded by ${name}`);
      sync(w);
    },
  });
}

function invite(world: WorldAPI, me: EntityState, target: string): void {
  const name = nameOf(me);
  const g = name ? guildOf(world, name) : undefined;
  const rank = g && name ? memberOf(g, name)?.rank : undefined;
  if (!name || !g || !rank) return tell(world, me.id, 'You are not in a guild.');
  if (rank === 'member') return tell(world, me.id, 'Only officers and the leader can invite.');
  const other = online(world).get(key(target.trim()));
  const otherName = nameOf(other);
  if (!other || !otherName) return tell(world, me.id, `No one called ${target.trim() || '…'} is online.`);
  if (other.id === me.id) return;
  if (guildOf(world, otherName)) return tell(world, me.id, `${otherName} is already in a guild.`);
  if (g.members.length >= MAX_MEMBERS) return tell(world, me.id, `The guild is full (${MAX_MEMBERS}).`);
  invites.set(key(otherName), { guildId: g.id, from: name, at: Date.now() });
  tell(world, me.id, `You invite ${otherName} to <${g.tag}> ${g.name}.`);
  tell(world, other.id, `${name} invites you to join <${g.tag}> ${g.name}. /gaccept or /gdecline.`);
  sync(world);
}

function respond(world: WorldAPI, me: EntityState, accept: boolean): void {
  const name = nameOf(me);
  if (!name) return;
  const inv = invites.get(key(name));
  invites.delete(key(name));
  const g = inv ? load(world).guilds.find((x) => x.id === inv.guildId) : undefined;
  if (!inv || !g || Date.now() - inv.at > INVITE_MS) {
    sync(world);
    return tell(world, me.id, 'You have no guild invitation.');
  }
  if (!accept) {
    const from = online(world).get(key(inv.from));
    if (from) tell(world, from.id, `${name} declines to join.`);
    sync(world);
    return tell(world, me.id, 'Invitation declined.');
  }
  if (guildOf(world, name)) return tell(world, me.id, 'You are already in a guild.');
  if (g.members.length >= MAX_MEMBERS) return tell(world, me.id, 'That guild is full.');
  const now = Date.now();
  g.members.push({ name, rank: 'member', joined: now, level: levelOf(me), seen: now });
  persist(world);
  tellGuild(world, g, `${name} has joined the guild.`);
  greeted.add(key(name));
  if (g.motd) tell(world, me.id, `Message of the day: ${g.motd}`);
  sync(world);
}

function remove(world: WorldAPI, g: Guild, name: string): void {
  const leaving = memberOf(g, name);
  g.members = g.members.filter((m) => key(m.name) !== key(name));
  const s = load(world);
  if (g.members.length === 0) {
    s.guilds = s.guilds.filter((x) => x.id !== g.id);
    world.log(`guild <${g.tag}> ${g.name} disbanded`);
  } else if (leaving?.rank === 'leader') {
    sort(g);
    g.members[0] = { ...g.members[0], rank: 'leader' };
    tellGuild(world, g, `${g.members[0].name} now leads the guild.`);
  }
  persist(world);
}

function leave(world: WorldAPI, me: EntityState): void {
  const name = nameOf(me);
  const g = name ? guildOf(world, name) : undefined;
  if (!name || !g) return tell(world, me.id, 'You are not in a guild.');
  tellGuild(world, g, `${name} has left the guild.`);
  remove(world, g, name);
  sync(world);
}

function kick(world: WorldAPI, me: EntityState, target: string): void {
  const name = nameOf(me);
  const g = name ? guildOf(world, name) : undefined;
  const mine = g && name ? memberOf(g, name) : undefined;
  const them = g ? memberOf(g, target.trim()) : undefined;
  if (!g || !mine) return tell(world, me.id, 'You are not in a guild.');
  if (!them) return tell(world, me.id, `${target.trim() || '…'} is not in your guild.`);
  if (them === mine) return tell(world, me.id, 'Use /gleave to leave.');
  if (RANK_ORDER[mine.rank] >= RANK_ORDER[them.rank]) return tell(world, me.id, `You cannot remove ${them.name}.`);
  tellGuild(world, g, `${them.name} was removed from the guild by ${mine.name}.`);
  remove(world, g, them.name);
  const e = online(world).get(key(them.name));
  if (e) tell(world, e.id, `You were removed from <${g.tag}> ${g.name}.`);
  sync(world);
}

function setRank(world: WorldAPI, me: EntityState, target: string, up: boolean): void {
  const name = nameOf(me);
  const g = name ? guildOf(world, name) : undefined;
  const mine = g && name ? memberOf(g, name) : undefined;
  const them = g ? memberOf(g, target.trim()) : undefined;
  if (!g || !mine) return tell(world, me.id, 'You are not in a guild.');
  if (mine.rank !== 'leader') return tell(world, me.id, 'Only the leader changes ranks.');
  if (!them || them === mine) return tell(world, me.id, `${target.trim() || '…'} is not in your guild.`);
  if (up && them.rank === 'member') {
    them.rank = 'officer';
    tellGuild(world, g, `${them.name} is now an officer.`);
  } else if (up && them.rank === 'officer') {
    them.rank = 'leader';
    mine.rank = 'officer';
    tellGuild(world, g, `${mine.name} hands the guild to ${them.name}, its new leader.`);
  } else if (!up && them.rank === 'officer') {
    them.rank = 'member';
    tellGuild(world, g, `${them.name} is no longer an officer.`);
  } else return;
  sort(g);
  persist(world);
  sync(world);
}

function setMotd(world: WorldAPI, me: EntityState, text: string): void {
  const name = nameOf(me);
  const g = name ? guildOf(world, name) : undefined;
  const mine = g && name ? memberOf(g, name) : undefined;
  if (!g || !mine) return tell(world, me.id, 'You are not in a guild.');
  if (mine.rank === 'member') return tell(world, me.id, 'Only officers and the leader set the message of the day.');
  g.motd = text.replace(/\s+/g, ' ').trim().slice(0, MAX_MOTD);
  persist(world);
  tellGuild(world, g, g.motd ? `Message of the day: ${g.motd}` : 'The message of the day was cleared.');
  sync(world);
}

function disband(world: WorldAPI, me: EntityState): void {
  const name = nameOf(me);
  const g = name ? guildOf(world, name) : undefined;
  if (!name || !g || memberOf(g, name)?.rank !== 'leader') return;
  tellGuild(world, g, `<${g.tag}> ${g.name} has been disbanded by ${name}.`);
  const s = load(world);
  s.guilds = s.guilds.filter((x) => x.id !== g.id);
  persist(world);
  world.log(`guild <${g.tag}> ${g.name} disbanded by ${name}`);
  sync(world);
}

function guildChat(world: WorldAPI, me: EntityState, text: string): void {
  const name = nameOf(me);
  const g = name ? guildOf(world, name) : undefined;
  if (!name || !g) return tell(world, me.id, 'You are not in a guild.');
  if (!text.trim()) return tell(world, me.id, HELP);
  const on = online(world);
  for (const m of g.members) {
    const e = on.get(key(m.name));
    if (e && chat) chat.deliver(world, e.id, { ch: 'guild', from: name, fromId: me.id, text: text.trim() });
  }
}

/** Nameplate tags, rosters, levels and last-seen times, and the login greeting. */
function sync(world: WorldAPI): void {
  const s = load(world);
  const on = online(world);
  const now = Date.now();
  let dirty = false;
  for (const [k, inv] of invites) if (now - inv.at > INVITE_MS) invites.delete(k);
  const byName = new Map<string, Guild>();
  for (const g of s.guilds) {
    for (const m of g.members) {
      byName.set(key(m.name), g);
      const e = on.get(key(m.name));
      if (!e) continue;
      const level = levelOf(e);
      if (level !== undefined && level !== m.level) {
        m.level = level;
        dirty = true;
      }
      if (!m.seen || now - m.seen > 5 * 60_000) {
        m.seen = now;
        dirty = true;
      }
    }
  }
  if (dirty) persist(world);
  for (const [k, p] of on) {
    const g = byName.get(k);
    const tag: GuildTag | undefined = g ? { tag: g.tag, name: g.name } : undefined;
    if (JSON.stringify(p.components['guilds:tag'] ?? null) !== JSON.stringify(tag ?? null)) world.update(p.id, { 'guilds:tag': tag });
    const inv = invites.get(k);
    const ig = inv ? s.guilds.find((x) => x.id === inv.guildId) : undefined;
    const roster: Roster = {};
    if (g) {
      const me = g.members.find((m) => key(m.name) === k);
      roster.guild = { id: g.id, name: g.name, tag: g.tag, motd: g.motd, founded: g.founded, me: me?.rank ?? 'member', members: g.members.map((m) => ({ ...m, online: on.has(key(m.name)) })) };
    }
    if (inv && ig && !g) roster.invite = { name: ig.name, tag: ig.tag, from: inv.from };
    if (JSON.stringify(p.components['guilds:roster'] ?? null) !== JSON.stringify(roster)) world.update(p.id, { 'guilds:roster': roster });
    if (g && !greeted.has(k)) {
      greeted.add(k);
      if (g.motd) tell(world, p.id, `<${g.tag}> Message of the day: ${g.motd}`);
    }
  }
  for (const k of greeted) if (!on.has(k)) greeted.delete(k);
}

type Args = Record<string, unknown>;
const args = (a: unknown): Args => (typeof a === 'object' && a !== null ? (a as Args) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function withMe(fn: (world: WorldAPI, me: EntityState, a: Args) => void) {
  return (world: WorldAPI, a: unknown, id: number): void => {
    const me = world.get(id);
    if (me) fn(world, me, args(a));
  };
}

export default definePlugin({
  id: 'guilds',
  items: [],
  recipes: [],
  entityKinds: [],
  privateComponents: ['guilds:roster'],

  systems: [
    {
      name: 'guilds:sync',
      fn: (world) => {
        clock++;
        if (clock % 10 === 0) sync(world);
      },
    },
  ],

  commands: [
    { name: 'guilds:found', fn: withMe((w, me, a) => found(w, me, a.name, a.tag)) },
    { name: 'guilds:invite', fn: withMe((w, me, a) => invite(w, me, str(a.name))) },
    { name: 'guilds:respond', fn: withMe((w, me, a) => respond(w, me, a.accept === true)) },
    { name: 'guilds:leave', fn: withMe((w, me) => leave(w, me)) },
    { name: 'guilds:kick', fn: withMe((w, me, a) => kick(w, me, str(a.name))) },
    { name: 'guilds:promote', fn: withMe((w, me, a) => setRank(w, me, str(a.name), true)) },
    { name: 'guilds:demote', fn: withMe((w, me, a) => setRank(w, me, str(a.name), false)) },
    { name: 'guilds:motd', fn: withMe((w, me, a) => setMotd(w, me, str(a.text))) },
    { name: 'guilds:disband', fn: withMe((w, me) => disband(w, me)) },
  ],

  events: {
    'chat:register-commands': (_world, payload) => {
      const offer = payload as Partial<ChatOffer>;
      if (typeof offer.register !== 'function' || typeof offer.deliver !== 'function') return;
      chat = offer as ChatOffer;
      chat.register(['gc', 'guild'], HELP, (w, me, rest) => guildChat(w, me, rest));
      chat.register(['ginvite', 'ginv'], '', (w, me, rest) => invite(w, me, rest));
      chat.register(['gaccept'], '', (w, me) => respond(w, me, true));
      chat.register(['gdecline'], '', (w, me) => respond(w, me, false));
      chat.register(['gleave'], '', (w, me) => leave(w, me));
      chat.register(['gkick'], '', (w, me, rest) => kick(w, me, rest));
      chat.register(['gpromote'], '', (w, me, rest) => setRank(w, me, rest, true));
      chat.register(['gdemote'], '', (w, me, rest) => setRank(w, me, rest, false));
      chat.register(['gmotd'], '', (w, me, rest) => setMotd(w, me, rest));
    },
  },
});
