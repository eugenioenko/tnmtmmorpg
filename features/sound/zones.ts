import type { Call } from './ambience.ts';
import type { Score } from './music.ts';

export interface CallRule {
  call: Call;
  /** Average calls per second. */
  rate: number;
  when: 'day' | 'night' | 'any';
}

export interface Zone {
  id: string;
  name: string;
  score: Score;
  wind: number;
  calls: CallRule[];
}

const MAJOR_PENTA = [0, 2, 4, 7, 9];
const LYDIAN = [0, 2, 4, 6, 7, 9, 11];
const DORIAN = [0, 2, 3, 5, 7, 9, 10];
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];
const PHRYGIAN_DOM = [0, 1, 4, 5, 7, 8, 10];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const HARMONIC_MINOR = [0, 2, 3, 5, 7, 8, 11];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];

const I = [0, 4, 7];
const IV = [5, 9, 12];
const V = [7, 11, 14];
const vi = [-3, 0, 4];
const i = [0, 3, 7];
const iv = [5, 8, 12];
const bVI = [-4, 0, 3];
const bVII = [-2, 2, 5];
const bII = [1, 5, 8];

const birds: CallRule = { call: 'bird', rate: 0.25, when: 'day' };
const crickets: CallRule = { call: 'cricket', rate: 1.6, when: 'night' };

export const ZONES: Record<string, Zone> = {
  village: {
    id: 'village',
    name: 'Lanternfall',
    score: { root: 62, scale: MAJOR_PENTA, bpm: 84, chords: [I, vi, IV, V], lead: 'lute', density: 0.42, pad: 0.03, bass: 0.12, drums: 'hand', drone: 0, send: 0.25 },
    wind: 0.015,
    calls: [birds, crickets, { call: 'owl', rate: 0.02, when: 'night' }],
  },
  meadow: {
    id: 'meadow',
    name: 'Open meadows',
    score: { root: 67, scale: LYDIAN, bpm: 70, chords: [I, [2, 6, 9], I, V], lead: 'flute', density: 0.3, pad: 0.035, bass: 0.08, drums: 'none', drone: 0, send: 0.4 },
    wind: 0.035,
    calls: [{ ...birds, rate: 0.4 }, crickets],
  },
  forest: {
    id: 'forest',
    name: 'The deep woods',
    score: { root: 64, scale: DORIAN, bpm: 64, chords: [i, IV, bVII, i], lead: 'flute', density: 0.26, pad: 0.04, bass: 0.1, drums: 'none', drone: 0.012, send: 0.5 },
    wind: 0.02,
    calls: [{ ...birds, rate: 0.3 }, { call: 'woodpecker', rate: 0.04, when: 'day' }, { call: 'owl', rate: 0.07, when: 'night' }, { ...crickets, rate: 0.8 }],
  },
  swamp: {
    id: 'swamp',
    name: 'The fens',
    score: { root: 61, scale: PHRYGIAN, bpm: 54, chords: [i, bII, i, bVII], lead: 'bell', density: 0.16, pad: 0.04, bass: 0.07, drums: 'none', drone: 0.02, send: 0.6 },
    wind: 0.01,
    calls: [{ call: 'frog', rate: 0.5, when: 'night' }, { call: 'frog', rate: 0.15, when: 'day' }, { ...crickets, rate: 0.6 }],
  },
  coast: {
    id: 'coast',
    name: 'The dunes',
    score: { root: 69, scale: PHRYGIAN_DOM, bpm: 92, chords: [I, bII, I, iv], lead: 'pluck', density: 0.38, pad: 0.025, bass: 0.1, drums: 'hand', drone: 0, send: 0.3 },
    wind: 0.04,
    calls: [{ call: 'gull', rate: 0.08, when: 'day' }, { ...crickets, rate: 0.5 }],
  },
  tundra: {
    id: 'tundra',
    name: 'The snowfields',
    score: { root: 71, scale: MAJOR_PENTA, bpm: 58, chords: [I, IV, vi, IV], lead: 'bell', density: 0.2, pad: 0.035, bass: 0, drums: 'none', drone: 0, send: 0.7 },
    wind: 0.07,
    calls: [],
  },
  highlands: {
    id: 'highlands',
    name: 'The highlands',
    score: { root: 62, scale: DORIAN, bpm: 60, chords: [i, bVII, bVI, bVII], lead: 'flute', density: 0.22, pad: 0.04, bass: 0.09, drums: 'none', drone: 0.015, send: 0.55 },
    wind: 0.06,
    calls: [{ ...birds, rate: 0.1 }],
  },
  cave: {
    id: 'cave',
    name: 'Underground',
    score: { root: 53, scale: MINOR, bpm: 48, chords: [i, bVI, iv, i], lead: 'bell', density: 0.08, pad: 0.025, bass: 0, drums: 'none', drone: 0.035, send: 0.85 },
    wind: 0.006,
    calls: [{ call: 'drip', rate: 0.5, when: 'any' }, { call: 'rumble', rate: 0.01, when: 'any' }],
  },
  interior: {
    id: 'interior',
    name: 'Indoors',
    score: { root: 65, scale: MAJOR, bpm: 76, chords: [I, IV, vi, V], lead: 'lute', density: 0.3, pad: 0.025, bass: 0.09, drums: 'none', drone: 0, send: 0.15 },
    wind: 0,
    calls: [{ call: 'crackle', rate: 0.5, when: 'any' }],
  },
  fire: {
    id: 'fire',
    name: 'Cinder Waste',
    score: { root: 62, scale: HARMONIC_MINOR, bpm: 100, chords: [i, bVI, iv, V], lead: 'pluck', density: 0.45, pad: 0.035, bass: 0.13, drums: 'hand', drone: 0.025, send: 0.3 },
    wind: 0.03,
    calls: [{ call: 'rumble', rate: 0.06, when: 'any' }, { call: 'crackle', rate: 0.3, when: 'any' }],
  },
  water: {
    id: 'water',
    name: 'Drowned Reach',
    score: { root: 63, scale: LYDIAN, bpm: 56, chords: [I, [2, 6, 9], vi, I], lead: 'bell', density: 0.2, pad: 0.045, bass: 0.06, drums: 'none', drone: 0.01, send: 0.75 },
    wind: 0.02,
    calls: [{ call: 'drip', rate: 0.15, when: 'any' }, { call: 'gull', rate: 0.04, when: 'day' }],
  },
  snow: {
    id: 'snow',
    name: 'White Silence',
    score: { root: 74, scale: MAJOR_PENTA, bpm: 52, chords: [vi, IV, I, V], lead: 'bell', density: 0.14, pad: 0.04, bass: 0, drums: 'none', drone: 0.01, send: 0.8 },
    wind: 0.09,
    calls: [],
  },
  verdant: {
    id: 'verdant',
    name: 'Green Deep',
    score: { root: 66, scale: LYDIAN, bpm: 74, chords: [I, V, vi, IV], lead: 'marimba', density: 0.4, pad: 0.03, bass: 0.1, drums: 'shaker', drone: 0, send: 0.35 },
    wind: 0.02,
    calls: [{ ...birds, rate: 0.6 }, { call: 'frog', rate: 0.1, when: 'any' }, crickets],
  },
};

const BY_TILE: Record<string, string> = {
  grass: 'meadow',
  dirt: 'meadow',
  forest: 'forest',
  swamp: 'swamp',
  sand: 'coast',
  snow: 'tundra',
  mountain: 'highlands',
};

/** The zone id for where the player stands; `tiles` are the kinds sampled around them. */
export function zoneFor(world: string, nearVillage: boolean, tiles: string[]): string {
  if (world.startsWith('interior:')) return 'interior';
  if (world.startsWith('dungeon:')) return 'cave';
  if (ZONES[world]) return world;
  if (nearVillage) return 'village';
  const votes: Record<string, number> = {};
  for (const t of tiles) {
    const z = BY_TILE[t];
    if (z) votes[z] = (votes[z] ?? 0) + 1;
  }
  let best = 'meadow';
  let most = 0;
  for (const [z, n] of Object.entries(votes)) {
    if (n > most) {
      best = z;
      most = n;
    }
  }
  return best;
}
