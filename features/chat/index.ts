import { definePlugin, type EntityState, type WorldAPI } from '@game/shared';

/**
 * Talking to other players. The client sends raw text with 'chat:send'; the
 * server reads slash commands, so every channel and emote lives here:
 *
 *   plain text        say, heard within SAY_RANGE tiles (speech bubble)
 *   /y  /yell         heard twice as far
 *   /g  /world        everyone online
 *   /w  /tell  name   private whisper; /r replies to the last one
 *   /me /e  text      custom emote; /wave, /bow, ... built-in emotes
 *   /roll [max]       a public dice roll
 *   /who              who is online
 *
 * Delivery: each player's `chat:inbox` (private: only its owner's
 * connection receives it) holds the last few lines, numbered so the client
 * shows each once. Speech is mirrored on the speaker's public `chat:bubble`.
 */

export interface ChatLine {
  n: number;
  ch: 'say' | 'yell' | 'world' | 'whisper-in' | 'whisper-out' | 'emote' | 'system';
  from?: string;
  fromId?: number;
  text: string;
  t: number;
}

interface Inbox {
  seq: number;
  lines: ChatLine[];
}

interface Bubble {
  n: number;
  text: string;
  emote: boolean;
  until: number;
}

const SAY_RANGE = 20;
const YELL_RANGE = 40;
const MAX_LEN = 180;
const KEEP_LINES = 12;
const LINE_TTL = 100;
const BUBBLE_TICKS = 45;
const RATE_WINDOW = 40;
const RATE_MAX = 6;

const EMOTES: Record<string, [alone: string, at: string]> = {
  wave: ['waves.', 'waves at {t}.'],
  bow: ['bows gracefully.', 'bows before {t}.'],
  cheer: ['cheers!', 'cheers at {t}!'],
  dance: ['bursts into dance.', 'dances with {t}.'],
  laugh: ['laughs.', 'laughs at {t}.'],
  cry: ['cries.', 'cries on {t}’s shoulder.'],
  salute: ['salutes.', 'salutes {t}.'],
  shrug: ['shrugs.', 'shrugs at {t}.'],
  point: ['points ahead.', 'points at {t}.'],
  flex: ['flexes. Impressive.', 'flexes at {t}.'],
  sleep: ['falls asleep.', 'falls asleep on {t}.'],
  thank: ['thanks everyone.', 'thanks {t}.'],
  hug: ['needs a hug.', 'hugs {t}.'],
  sit: ['sits down.', 'sits down beside {t}.'],
  greet: ['greets everyone warmly.', 'greets {t} warmly.'],
};

const HELP = [
  'Say: just type. /y yell · /g world · /w name whisper · /r reply',
  `/me text · /roll · /who · emotes: ${Object.keys(EMOTES).map((e) => `/${e}`).join(' ')}`,
];

let clock = 0;
const sent = new Map<number, number[]>();
const lastWhisperFrom = new Map<number, number>();

function nameOf(e: EntityState | undefined): string {
  const c = e?.components.character as { name?: unknown } | undefined;
  if (typeof c?.name === 'string') return c.name;
  return e ? `Wanderer ${e.id}` : 'Someone';
}

function inboxOf(e: EntityState): Inbox {
  const box = e.components['chat:inbox'] as Inbox | undefined;
  return box && Array.isArray(box.lines) && typeof box.seq === 'number'
    ? box
    : { seq: 0, lines: [] };
}

function deliver(world: WorldAPI, to: EntityState, line: Omit<ChatLine, 'n' | 't'>): void {
  const box = inboxOf(to);
  const seq = box.seq + 1;
  const lines = box.lines.filter((l) => clock - l.t < LINE_TTL).slice(-(KEEP_LINES - 1));
  lines.push({ ...line, n: seq, t: clock });
  world.update(to.id, { 'chat:inbox': { seq, lines } });
}

function system(world: WorldAPI, to: EntityState, text: string): void {
  deliver(world, to, { ch: 'system', text });
}

function clean(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LEN);
}

function players(world: WorldAPI): EntityState[] {
  return world.query('player');
}

function nearbyPlayers(world: WorldAPI, from: EntityState, range: number): EntityState[] {
  return world
    .queryNear(from.x, from.y, range, from.world)
    .filter((e) => e.kind === 'player');
}

/** Whole-name match first, then a unique prefix; case-insensitive. */
function findPlayer(world: WorldAPI, query: string): EntityState | 'ambiguous' | undefined {
  const q = query.toLowerCase();
  const all = players(world);
  const exact = all.filter((p) => nameOf(p).toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const firstName = all.filter((p) => nameOf(p).toLowerCase().split(' ')[0] === q);
  if (firstName.length === 1) return firstName[0];
  const prefix = all.filter((p) => nameOf(p).toLowerCase().startsWith(q));
  if (prefix.length === 1) return prefix[0];
  return prefix.length > 1 || firstName.length > 1 ? 'ambiguous' : undefined;
}

function rateLimited(id: number): boolean {
  const times = (sent.get(id) ?? []).filter((t) => clock - t < RATE_WINDOW);
  if (times.length >= RATE_MAX) {
    sent.set(id, times);
    return true;
  }
  times.push(clock);
  sent.set(id, times);
  return false;
}

function bubble(world: WorldAPI, speaker: EntityState, text: string, emote: boolean): void {
  const prev = speaker.components['chat:bubble'] as Bubble | undefined;
  const n = (prev?.n ?? 0) + 1;
  world.update(speaker.id, {
    'chat:bubble': { n, text: text.slice(0, 90), emote, until: clock + BUBBLE_TICKS },
  });
}

function speak(world: WorldAPI, me: EntityState, text: string, ch: 'say' | 'yell'): void {
  const range = ch === 'yell' ? YELL_RANGE : SAY_RANGE;
  const from = nameOf(me);
  for (const p of nearbyPlayers(world, me, range)) {
    deliver(world, p, { ch, from, fromId: me.id, text });
  }
  bubble(world, me, ch === 'yell' ? text.toUpperCase() : text, false);
}

function emote(world: WorldAPI, me: EntityState, action: string): void {
  const text = `${nameOf(me)} ${action}`;
  for (const p of nearbyPlayers(world, me, SAY_RANGE)) {
    deliver(world, p, { ch: 'emote', fromId: me.id, text });
  }
  bubble(world, me, `*${action.replace(/[.!]$/, '')}*`, true);
}

function whisper(world: WorldAPI, me: EntityState, target: EntityState, text: string): void {
  if (target.id === me.id) {
    system(world, me, 'You mutter to yourself.');
    return;
  }
  deliver(world, target, { ch: 'whisper-in', from: nameOf(me), fromId: me.id, text });
  const fresh = world.get(me.id);
  if (fresh) deliver(world, fresh, { ch: 'whisper-out', from: nameOf(target), fromId: target.id, text });
  lastWhisperFrom.set(target.id, me.id);
}

function who(world: WorldAPI, me: EntityState): void {
  const all = players(world);
  const list = all
    .slice(0, 20)
    .map((p) => {
      const level = (p.components.stats as { level?: number } | undefined)?.level;
      return `${nameOf(p)}${level ? ` (${level})` : ''}`;
    })
    .join(', ');
  system(world, me, `${all.length} online: ${list}${all.length > 20 ? ', …' : ''}`);
}

function handle(world: WorldAPI, me: EntityState, raw: string): void {
  const text = clean(raw);
  if (!text) return;
  if (!text.startsWith('/')) {
    speak(world, me, text, 'say');
    return;
  }
  const space = text.indexOf(' ');
  const cmd = (space < 0 ? text.slice(1) : text.slice(1, space)).toLowerCase();
  const rest = space < 0 ? '' : text.slice(space + 1).trim();

  switch (cmd) {
    case 's':
    case 'say':
      if (rest) speak(world, me, rest, 'say');
      return;
    case 'y':
    case 'yell':
    case 'shout':
      if (rest) speak(world, me, rest, 'yell');
      return;
    case 'g':
    case 'w0':
    case 'world':
    case 'global': {
      if (!rest) return;
      const from = nameOf(me);
      for (const p of players(world)) deliver(world, p, { ch: 'world', from, fromId: me.id, text: rest });
      return;
    }
    case 'w':
    case 'whisper':
    case 'tell':
    case 't':
    case 'msg': {
      const target = whisperTarget(world, rest);
      if (!target) {
        system(world, me, 'Whisper to whom? Try /w Name message.');
        return;
      }
      if (target.player === 'ambiguous') {
        system(world, me, `More than one player matches “${target.name}”. Use more of the name.`);
        return;
      }
      if (!target.player) {
        system(world, me, `No one called “${target.name}” is online.`);
        return;
      }
      if (!target.text) {
        system(world, me, `What do you want to tell ${nameOf(target.player)}?`);
        return;
      }
      whisper(world, me, target.player, target.text);
      return;
    }
    case 'r':
    case 'reply': {
      const id = lastWhisperFrom.get(me.id);
      const target = id === undefined ? undefined : world.get(id);
      if (!target) {
        system(world, me, 'Nobody has whispered to you lately.');
        return;
      }
      if (rest) whisper(world, me, target, rest);
      return;
    }
    case 'me':
    case 'e':
    case 'emote':
      if (rest) emote(world, me, rest);
      return;
    case 'roll': {
      const max = Number.parseInt(rest, 10);
      const top = Number.isFinite(max) && max > 1 && max <= 1000 ? max : 100;
      const value = 1 + ((world.rng() * top) | 0);
      emote(world, me, `rolls ${value} (1-${top}).`);
      return;
    }
    case 'who':
    case 'online':
      who(world, me);
      return;
    case 'help':
    case '?':
      for (const line of HELP) system(world, world.get(me.id) ?? me, line);
      return;
  }

  const forms = EMOTES[cmd];
  if (forms) {
    const target = rest ? findPlayer(world, rest) : undefined;
    const targetName = target && target !== 'ambiguous' ? nameOf(target) : rest;
    emote(world, me, targetName ? forms[1].replace('{t}', targetName) : forms[0]);
    return;
  }
  system(world, me, `Unknown command /${cmd}. Type /help for the list.`);
}

/** "/w Name Words" — names have spaces, so take the longest prefix that names a player. */
function whisperTarget(
  world: WorldAPI,
  rest: string,
): { player: EntityState | 'ambiguous' | undefined; name: string; text: string } | undefined {
  const words = rest.split(' ').filter(Boolean);
  if (words.length === 0) return undefined;
  for (let take = words.length < 4 ? words.length : 4; take >= 1; take--) {
    const name = words.slice(0, take).join(' ');
    const player = findPlayer(world, name);
    if (player) return { player, name, text: words.slice(take).join(' ') };
  }
  return { player: undefined, name: words[0], text: words.slice(1).join(' ') };
}

export default definePlugin({
  id: 'chat',
  items: [],
  recipes: [],
  entityKinds: [],
  privateComponents: ['chat:inbox'],

  systems: [
    {
      name: 'chat:tick',
      fn: (world) => {
        clock++;
        if (clock % 10 !== 0) return;
        for (const e of world.query('chat:bubble')) {
          const b = e.components['chat:bubble'] as Bubble | undefined;
          if (b && clock >= b.until) world.update(e.id, { 'chat:bubble': undefined });
        }
        for (const e of world.query('chat:inbox')) {
          const box = inboxOf(e);
          const newest = box.lines[box.lines.length - 1];
          if (newest && clock - newest.t >= LINE_TTL) {
            world.update(e.id, { 'chat:inbox': { seq: box.seq, lines: [] } });
          }
        }
        if (clock % 600 === 0) {
          for (const id of sent.keys()) if (!world.get(id)) sent.delete(id);
          for (const id of lastWhisperFrom.keys()) if (!world.get(id)) lastWhisperFrom.delete(id);
        }
      },
    },
  ],

  commands: [
    {
      name: 'chat:send',
      fn: (world, args, entityId) => {
        const text = (args as { text?: unknown } | undefined)?.text;
        const me = world.get(entityId);
        if (typeof text !== 'string' || !me) return;
        if (rateLimited(entityId)) {
          system(world, me, 'You are speaking too quickly. Take a breath.');
          return;
        }
        handle(world, me, text);
      },
    },
  ],

  events: {},
});
