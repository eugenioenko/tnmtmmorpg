import { definePlugin } from '@game/shared';

/**
 * The time of day. One game hour passes every REAL_MS_PER_HOUR of wall
 * clock, so a day lasts 48 minutes, survives restarts without being stored,
 * and every server agrees on it.
 *
 * Other features follow along through 'daynight:hour' { hour, day },
 * emitted on the first tick and whenever the hour turns. Each player
 * carries a small private `daynight:time` { minute, day } (minute of the
 * day, 0-1439) for the client's tint and clock; it changes every ten game
 * minutes.
 */

export const REAL_MS_PER_HOUR = 120_000;

/** Server-side only: DAYNIGHT_SHIFT_HOURS moves the clock, e.g. to preview night locally. */
const SHIFT_MS = (Number(globalThis.process?.env?.DAYNIGHT_SHIFT_HOURS) || 0) * REAL_MS_PER_HOUR;

export interface DayTime {
  minute: number;
  day: number;
}

export function now(ms: number): DayTime {
  const minutes = (ms / (REAL_MS_PER_HOUR / 60)) | 0;
  const minute = minutes % 1440;
  return { minute: minute - (minute % 10), day: ((minutes / 1440) | 0) % 10000 };
}

let lastHour = -1;
let clock = 0;

export default definePlugin({
  id: 'daynight',
  items: [],
  recipes: [],
  entityKinds: [],
  privateComponents: ['daynight:time'],

  systems: [
    {
      name: 'daynight:tick',
      fn: (world) => {
        clock++;
        if (clock % 10 !== 1) return;
        const t = now(Date.now() + SHIFT_MS);
        const hour = (t.minute / 60) | 0;
        if (hour !== lastHour) {
          lastHour = hour;
          world.emit('daynight:hour', { hour, day: t.day });
        }
        for (const p of world.query('player')) {
          const mine = p.components['daynight:time'] as DayTime | undefined;
          if (mine?.minute === t.minute && mine.day === t.day) continue;
          world.update(p.id, { 'daynight:time': t });
        }
      },
    },
  ],

  commands: [],
  events: {},
});
