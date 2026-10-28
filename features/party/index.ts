import { definePlugin, isStatsComponent, OVERWORLD, type EntityState, type WorldAPI } from '@game/shared';

/**
 * Adventuring together. A player invites another (`/invite Name`, or the
 * Party window's nearby list); once accepted they share a party of up to
 * five. Party members:
 *
 *   - see each other's health and whereabouts in the party frames;
 *   - talk on the party channel (`/p text`);
 *   - share kills: everyone within SHARE_RANGE of a monster a member fells
 *     earns part of its experience and quest credit;
 *   - land in the same copy of a cave (dungeons reads `party:tag`).
 *
 * Parties are keyed by character name, not entity id, so a member who logs
 * out keeps their place for OFFLINE_GRACE and rejoins on return. They are
 * process-local: a server restart disbands every party.
 *
 * Experience goes out through the character feature's 'character:grant';
 * quest credit is a second 'bestiary:slain' for each helper, marked
 * `assist: true`. Chat lines go through the chat feature's
 * 'chat:register-commands' offer.
 */

export interface RosterMember {
  name: string;
  online: boolean;
  id?: number;
  level?: number;
  hp?: number;
  maxHp?: number;
  world?: string;
  x?: number;
  y?: number;
}

/** Everything the party frames show; private to its owner. */
export interface Roster {
  party?: { id: number; leader: string; members: RosterMember[] };
  invite?: { from: string };
  outgoing?: { to: string };
}

/** Public: lets clients mark party members and other features group them. */
export interface PartyTag {
  id: number;
}

interface Party {
  id: number;
  leader: string;
  members: string[];
}

interface Invite {
  fromKey: string;
  fromName: string;
  until: number;
}

interface ChatOffer {
  register(names: string[], help: string, fn: (world: WorldAPI, me: EntityState, rest: string) => void): void;
  deliver(world: WorldAPI, toId: number, line: { ch: string; from?: string; fromId?: number; text: string }): void;
}

export const MAX_SIZE = 5;
const SHARE_RANGE = 30;
const SHARE = 0.6;
const INVITE_TICKS = 300;
const OFFLINE_GRACE = 3000;
const ROSTER_EVERY = 5;

const floor = (n: number): number => n | 0;
const keyOf = (name: string): string => name.toLowerCase();

let clock = 0;
let nextId = 1;
let chat: ChatOffer | undefined;
const parties = new Map<number, Party>();
const partyOf = new Map<string, number>();
const invites = new Map<string, Invite>();
const offlineSince = new Map<string, number>();
const lastRoster = new Map<number, string>();

function nameOf(e: EntityState | undefined): string | undefined {
  const c = e?.components.character as { name?: unknown } | undefined;
  return typeof c?.name === 'string' ? c.name : undefined;
}

function onlineByKey(world: WorldAPI): Map<string, EntityState> {
  const out = new Map<string, EntityState>();
  for (const p of world.query('player')) {
    const name = nameOf(p);
    if (name) out.set(keyOf(name), p);
  }
  return out;
}

function findOnline(world: WorldAPI, query: string): EntityState | 'ambiguous' | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const all = [...onlineByKey(world)];
  const exact = all.find(([k]) => k === q);
  if (exact) return exact[1];
  const prefix = all.filter(([k]) => k.startsWith(q));
  if (prefix.length === 1) return prefix[0][1];
  return prefix.length > 1 ? 'ambiguous' : undefined;
}

function tell(world: WorldAPI, toId: number, text: string): void {
  chat?.deliver(world, toId, { ch: 'party', text });
}

function tellParty(world: WorldAPI, party: Party, text: string, online = onlineByKey(world)): void {
  for (const m of party.members) {
    const e = online.get(keyOf(m));
    if (e) tell(world, e.id, text);
  }
}

function partyFor(name: string): Party | undefined {
  const id = partyOf.get(keyOf(name));
  return id === undefined ? undefined : parties.get(id);
}

function tag(world: WorldAPI, e: EntityState | undefined, party: Party | undefined): void {
  if (!e) return;
  const current = (e.components['party:tag'] as PartyTag | undefined)?.id;
  if (current === party?.id) return;
  world.update(e.id, { 'party:tag': party ? ({ id: party.id } satisfies PartyTag) : undefined });
}

function removeMember(world: WorldAPI, party: Party, name: string, why: string): void {
  const key = keyOf(name);
  party.members = party.members.filter((m) => keyOf(m) !== key);
  partyOf.delete(key);
  offlineSince.delete(key);
  const online = onlineByKey(world);
  const gone = online.get(key);
  tag(world, gone, undefined);
  if (party.members.length < 2) {
    for (const m of party.members) {
      partyOf.delete(keyOf(m));
      offlineSince.delete(keyOf(m));
      const e = online.get(keyOf(m));
      tag(world, e, undefined);
      if (e) tell(world, e.id, `${why} The party has disbanded.`);
    }
    parties.delete(party.id);
    return;
  }
  if (keyOf(party.leader) === key) {
    party.leader = party.members.find((m) => online.has(keyOf(m))) ?? party.members[0];
    tellParty(world, party, `${why} ${party.leader} now leads the party.`, online);
    return;
  }
  tellParty(world, party, why, online);
}

function invite(world: WorldAPI, me: EntityState, target: EntityState | 'ambiguous' | undefined, query: string): void {
  const myName = nameOf(me);
  if (!myName) return;
  if (target === 'ambiguous') return tell(world, me.id, `More than one player matches “${query}”. Use more of the name.`);
  const theirName = nameOf(target);
  if (!target || !theirName) return tell(world, me.id, query ? `No one called “${query}” is online.` : 'Invite whom? Try /invite Name.');
  if (target.id === me.id) return tell(world, me.id, 'You are already on your own side.');
  const mine = partyFor(myName);
  if (mine && keyOf(mine.leader) !== keyOf(myName)) return tell(world, me.id, `Only ${mine.leader} can invite people.`);
  if (mine && mine.members.length >= MAX_SIZE) return tell(world, me.id, `The party is full (${MAX_SIZE}).`);
  if (partyFor(theirName)) return tell(world, me.id, `${theirName} is already in a party.`);
  const pending = invites.get(keyOf(theirName));
  if (pending && pending.until > clock && pending.fromKey !== keyOf(myName)) {
    return tell(world, me.id, `${theirName} is considering another invitation.`);
  }
  invites.set(keyOf(theirName), { fromKey: keyOf(myName), fromName: myName, until: clock + INVITE_TICKS });
  tell(world, me.id, `You invite ${theirName} to your party.`);
  tell(world, target.id, `${myName} invites you to their party.`);
}

function respond(world: WorldAPI, me: EntityState, accept: boolean): void {
  const myName = nameOf(me);
  if (!myName) return;
  const inv = invites.get(keyOf(myName));
  invites.delete(keyOf(myName));
  if (!inv || inv.until <= clock) return;
  const online = onlineByKey(world);
  const host = online.get(inv.fromKey);
  if (!accept) {
    if (host) tell(world, host.id, `${myName} declines your invitation.`);
    return;
  }
  if (!host) return tell(world, me.id, `${inv.fromName} is no longer around.`);
  if (partyFor(myName)) return tell(world, me.id, 'You are already in a party.');
  let party = partyFor(inv.fromName);
  if (party && keyOf(party.leader) !== inv.fromKey) return tell(world, me.id, `${inv.fromName} no longer leads their party.`);
  if (party && party.members.length >= MAX_SIZE) return tell(world, me.id, 'That party is full.');
  if (!party) {
    party = { id: nextId++, leader: inv.fromName, members: [inv.fromName] };
    parties.set(party.id, party);
    partyOf.set(inv.fromKey, party.id);
    tag(world, host, party);
  }
  party.members.push(myName);
  partyOf.set(keyOf(myName), party.id);
  tag(world, me, party);
  tellParty(world, party, `${myName} joins the party.`, online);
}

function leave(world: WorldAPI, me: EntityState): void {
  const name = nameOf(me);
  const party = name ? partyFor(name) : undefined;
  if (!name || !party) return tell(world, me.id, 'You are not in a party.');
  tell(world, me.id, 'You leave the party.');
  removeMember(world, party, name, `${name} leaves the party.`);
}

function kick(world: WorldAPI, me: EntityState, query: string): void {
  const name = nameOf(me);
  const party = name ? partyFor(name) : undefined;
  if (!name || !party) return tell(world, me.id, 'You are not in a party.');
  if (keyOf(party.leader) !== keyOf(name)) return tell(world, me.id, `Only ${party.leader} can do that.`);
  const q = query.trim().toLowerCase();
  const match = party.members.filter((m) => keyOf(m) !== keyOf(name) && keyOf(m).startsWith(q));
  if (!q || match.length !== 1) return tell(world, me.id, q ? `No single party member matches “${query}”.` : 'Remove whom? Try /kick Name.');
  const online = onlineByKey(world).get(keyOf(match[0]));
  if (online) tell(world, online.id, `${name} removed you from the party.`);
  removeMember(world, party, match[0], `${match[0]} was removed from the party.`);
}

function promote(world: WorldAPI, me: EntityState, query: string): void {
  const name = nameOf(me);
  const party = name ? partyFor(name) : undefined;
  if (!name || !party) return tell(world, me.id, 'You are not in a party.');
  if (keyOf(party.leader) !== keyOf(name)) return tell(world, me.id, `Only ${party.leader} can do that.`);
  const q = query.trim().toLowerCase();
  const match = party.members.filter((m) => keyOf(m) !== keyOf(name) && keyOf(m).startsWith(q));
  if (!q || match.length !== 1) return tell(world, me.id, `No single party member matches “${query}”.`);
  party.leader = match[0];
  tellParty(world, party, `${match[0]} now leads the party.`);
}

function partyChat(world: WorldAPI, me: EntityState, text: string): void {
  const name = nameOf(me);
  const party = name ? partyFor(name) : undefined;
  if (!name || !party) return tell(world, me.id, 'You are not in a party. /invite Name to start one.');
  if (!text) {
    const online = onlineByKey(world);
    const list = party.members
      .map((m) => `${m}${keyOf(m) === keyOf(party.leader) ? ' (leader)' : ''}${online.has(keyOf(m)) ? '' : ' (away)'}`)
      .join(', ');
    return tell(world, me.id, `Party: ${list}`);
  }
  const online = onlineByKey(world);
  for (const m of party.members) {
    const e = online.get(keyOf(m));
    if (e) chat?.deliver(world, e.id, { ch: 'party', from: name, fromId: me.id, text });
  }
}

function rosterFor(party: Party, online: Map<string, EntityState>): Roster['party'] {
  return {
    id: party.id,
    leader: party.leader,
    members: party.members.map((name) => {
      const e = online.get(keyOf(name));
      if (!e) return { name, online: false };
      const s = e.components.stats;
      return {
        name,
        online: true,
        id: e.id,
        level: isStatsComponent(s) ? s.level : undefined,
        hp: isStatsComponent(s) ? s.hp : undefined,
        maxHp: isStatsComponent(s) ? s.maxHp : undefined,
        world: e.world ?? OVERWORLD,
        x: e.x,
        y: e.y,
      };
    }),
  };
}

function refresh(world: WorldAPI): void {
  const online = onlineByKey(world);
  for (const [key, inv] of invites) if (inv.until <= clock) invites.delete(key);

  for (const party of [...parties.values()]) {
    for (const m of [...party.members]) {
      const k = keyOf(m);
      if (online.has(k)) {
        offlineSince.delete(k);
        tag(world, online.get(k), party);
        continue;
      }
      const since = offlineSince.get(k);
      if (since === undefined) offlineSince.set(k, clock);
      else if (clock - since >= OFFLINE_GRACE) removeMember(world, party, m, `${m} has been away too long and left the party.`);
    }
  }

  const outgoing = new Map<string, string>();
  for (const [key, inv] of invites) {
    const target = online.get(key);
    const name = nameOf(target);
    if (name) outgoing.set(inv.fromKey, name);
  }

  for (const [key, e] of online) {
    const party = partyFor(key);
    if (!party) tag(world, e, undefined);
    const inv = invites.get(key);
    const roster: Roster = {
      party: party ? rosterFor(party, online) : undefined,
      invite: inv ? { from: inv.fromName } : undefined,
      outgoing: outgoing.has(key) ? { to: outgoing.get(key) as string } : undefined,
    };
    const json = JSON.stringify(roster);
    if (lastRoster.get(e.id) === json) continue;
    lastRoster.set(e.id, json);
    world.update(e.id, { 'party:roster': roster.party || roster.invite || roster.outgoing ? roster : undefined });
  }
  for (const id of lastRoster.keys()) if (!world.get(id)) lastRoster.delete(id);
}

function shareKill(world: WorldAPI, payload: unknown): void {
  const ev = payload as {
    killerId?: unknown;
    species?: unknown;
    name?: unknown;
    world?: unknown;
    x?: unknown;
    y?: unknown;
    xp?: unknown;
    assist?: unknown;
  };
  if (ev.assist || typeof ev.killerId !== 'number' || typeof ev.xp !== 'number') return;
  const killer = world.get(ev.killerId);
  const killerName = nameOf(killer);
  const party = killerName ? partyFor(killerName) : undefined;
  if (!killer || !killerName || !party) return;
  const where = typeof ev.world === 'string' ? ev.world : (killer.world ?? OVERWORLD);
  const x = typeof ev.x === 'number' ? ev.x : killer.x;
  const y = typeof ev.y === 'number' ? ev.y : killer.y;
  const share = floor(ev.xp * SHARE) || 1;
  const label = typeof ev.name === 'string' ? ev.name : 'A foe';
  const online = onlineByKey(world);
  for (const m of party.members) {
    const e = online.get(keyOf(m));
    if (!e || e.id === killer.id || (e.world ?? OVERWORLD) !== where) continue;
    const dx = e.x - x;
    const dy = e.y - y;
    if ((dx < 0 ? -dx : dx) > SHARE_RANGE || (dy < 0 ? -dy : dy) > SHARE_RANGE) continue;
    const s = e.components.stats;
    if (isStatsComponent(s) && s.hp <= 0) continue;
    world.emit('character:grant', { entityId: e.id, xp: share, reason: `Party kill: ${label} · +${share} XP`, tone: 'good' });
    world.emit('bestiary:slain', { ...ev, killerId: e.id, assist: true });
  }
}

const HELP = '/invite name · /p text party chat · /p roster · /kick name · /promote name · /pleave';

export default definePlugin({
  id: 'party',
  items: [],
  recipes: [],
  entityKinds: [],
  privateComponents: ['party:roster'],

  systems: [
    {
      name: 'party:tick',
      fn: (world) => {
        clock++;
        if (clock % ROSTER_EVERY === 0) refresh(world);
      },
    },
  ],

  commands: [
    {
      name: 'party:invite',
      fn: (world, args, entityId) => {
        const me = world.get(entityId);
        const targetId = (args as { targetId?: unknown } | undefined)?.targetId;
        if (!me || typeof targetId !== 'number') return;
        const target = world.get(targetId);
        invite(world, me, target?.kind === 'player' ? target : undefined, nameOf(target) ?? '');
      },
    },
    {
      name: 'party:respond',
      fn: (world, args, entityId) => {
        const me = world.get(entityId);
        if (me) respond(world, me, (args as { accept?: unknown } | undefined)?.accept === true);
      },
    },
    {
      name: 'party:leave',
      fn: (world, _args, entityId) => {
        const me = world.get(entityId);
        if (me) leave(world, me);
      },
    },
    {
      name: 'party:kick',
      fn: (world, args, entityId) => {
        const me = world.get(entityId);
        const name = (args as { name?: unknown } | undefined)?.name;
        if (me && typeof name === 'string') kick(world, me, name);
      },
    },
    {
      name: 'party:promote',
      fn: (world, args, entityId) => {
        const me = world.get(entityId);
        const name = (args as { name?: unknown } | undefined)?.name;
        if (me && typeof name === 'string') promote(world, me, name);
      },
    },
  ],

  events: {
    'chat:register-commands': (_world, payload) => {
      const offer = payload as Partial<ChatOffer>;
      if (typeof offer.register !== 'function' || typeof offer.deliver !== 'function') return;
      chat = offer as ChatOffer;
      chat.register(['invite', 'inv'], HELP, (world, me, rest) => invite(world, me, findOnline(world, rest), rest));
      chat.register(['p', 'party'], '', (world, me, rest) => partyChat(world, me, rest));
      chat.register(['pleave', 'leaveparty'], '', (world, me) => leave(world, me));
      chat.register(['kick'], '', (world, me, rest) => kick(world, me, rest));
      chat.register(['promote'], '', (world, me, rest) => promote(world, me, rest));
      chat.register(['accept'], '', (world, me) => respond(world, me, true));
      chat.register(['decline'], '', (world, me) => respond(world, me, false));
    },
    'bestiary:slain': shareKill,
  },
});
