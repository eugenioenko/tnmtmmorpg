import { envelope, filter, hz, noiseBurst, out, rand, tone, type Engine } from './engine.ts';
import { playLead } from './music.ts';

export type Effect =
  | 'step'
  | 'chop'
  | 'mine'
  | 'hit'
  | 'hurt'
  | 'fall'
  | 'levelup'
  | 'coins'
  | 'pickup'
  | 'whoosh'
  | 'travel';

/** Footstep colour by ground: [filter, centre Hz, length, level]. */
const GROUND: Record<string, [BiquadFilterType, number, number, number]> = {
  grass: ['bandpass', 900, 0.07, 0.05],
  forest: ['bandpass', 750, 0.08, 0.055],
  swamp: ['lowpass', 500, 0.11, 0.07],
  dirt: ['lowpass', 380, 0.06, 0.09],
  sand: ['highpass', 2200, 0.1, 0.04],
  snow: ['bandpass', 1400, 0.12, 0.06],
  floor: ['lowpass', 600, 0.04, 0.08],
  bridge: ['lowpass', 300, 0.05, 0.12],
};

export function effect(e: Engine, kind: Effect, t: number, vel = 1, ground = 'grass'): void {
  const bus = e.sfx;
  switch (kind) {
    case 'step': {
      const [type, f, len, level] = GROUND[ground] ?? GROUND.grass;
      const g = envelope(e, t, 0.004, 1.6 * level * vel * (0.8 + rand() * 0.4), len);
      noiseBurst(e, t, len + 0.02, g);
      const flt = filter(e, type, f * (0.9 + rand() * 0.2), 1);
      g.connect(flt);
      out(e, flt, bus);
      if (ground === 'bridge' || ground === 'floor') {
        const k = envelope(e, t, 0.002, 0.05 * vel, 0.08);
        tone(e, 'sine', ground === 'bridge' ? 190 : 260, t, 0.1, k);
        out(e, k, bus);
      }
      break;
    }
    case 'chop': {
      const g = envelope(e, t, 0.002, 0.22 * vel, 0.12);
      const osc = tone(e, 'sine', 180, t, 0.15, g);
      osc.frequency.exponentialRampToValueAtTime(90, t + 0.1);
      out(e, g, bus, 0.15);
      const n = envelope(e, t, 0.001, 0.12 * vel, 0.06);
      noiseBurst(e, t, 0.08, n);
      const bp = filter(e, 'bandpass', 1100, 1.2);
      n.connect(bp);
      out(e, bp, bus, 0.15);
      break;
    }
    case 'mine': {
      for (const [ratio, level, len] of [[1, 0.12, 0.35], [2.76, 0.06, 0.2], [4.1, 0.04, 0.12]] as const) {
        const g = envelope(e, t, 0.001, level * vel, len);
        tone(e, 'sine', 1800 * ratio * (0.97 + rand() * 0.06), t, len + 0.05, g);
        out(e, g, bus, 0.3);
      }
      const n = envelope(e, t, 0.001, 0.1 * vel, 0.04);
      noiseBurst(e, t, 0.05, n);
      const hp = filter(e, 'highpass', 3000);
      n.connect(hp);
      out(e, hp, bus);
      break;
    }
    case 'hit': {
      const n = envelope(e, t, 0.001, 0.18 * vel, 0.09);
      noiseBurst(e, t, 0.1, n);
      const bp = filter(e, 'bandpass', 700 + rand() * 400, 0.9);
      n.connect(bp);
      out(e, bp, bus, 0.1);
      const g = envelope(e, t, 0.002, 0.12 * vel, 0.1);
      const osc = tone(e, 'triangle', 120, t, 0.12, g);
      osc.frequency.exponentialRampToValueAtTime(60, t + 0.1);
      out(e, g, bus);
      break;
    }
    case 'hurt': {
      const g = envelope(e, t, 0.003, 0.2 * vel, 0.22);
      const osc = tone(e, 'sawtooth', 160, t, 0.25, g);
      osc.frequency.exponentialRampToValueAtTime(70, t + 0.2);
      const lp = filter(e, 'lowpass', 600);
      g.connect(lp);
      out(e, lp, bus, 0.1);
      break;
    }
    case 'fall': {
      const g = envelope(e, t, 0.01, 0.25 * vel, 0.5);
      noiseBurst(e, t, 0.55, g);
      const lp = filter(e, 'lowpass', 900);
      lp.frequency.setValueAtTime(900, t);
      lp.frequency.exponentialRampToValueAtTime(120, t + 0.5);
      g.connect(lp);
      out(e, lp, bus, 0.3);
      break;
    }
    case 'levelup': {
      [72, 76, 79, 84, 88].forEach((n, i) => playLead(e, 'bell', n, t + i * 0.09, 0.3, 0.1 * vel, bus, 0.5));
      break;
    }
    case 'coins': {
      for (let i = 0; i < 3; i++) {
        const at = t + i * 0.06 + rand() * 0.02;
        const g = envelope(e, at, 0.001, 0.07 * vel, 0.18);
        tone(e, 'sine', 2600 + rand() * 900, at, 0.2, g);
        out(e, g, bus, 0.2);
      }
      break;
    }
    case 'pickup': {
      const g = envelope(e, t, 0.003, 0.09 * vel, 0.1);
      const osc = tone(e, 'sine', hz(74), t, 0.12, g);
      osc.frequency.exponentialRampToValueAtTime(hz(81), t + 0.07);
      out(e, g, bus, 0.15);
      break;
    }
    case 'whoosh': {
      const g = envelope(e, t, 0.08, 0.3 * vel, 0.3);
      noiseBurst(e, t, 0.4, g);
      const bp = filter(e, 'bandpass', 400, 1.5);
      bp.frequency.exponentialRampToValueAtTime(1800, t + 0.3);
      g.connect(bp);
      out(e, bp, bus, 0.2);
      break;
    }
    case 'travel': {
      [84, 79, 76, 72, 67].forEach((n, i) => playLead(e, 'bell', n, t + i * 0.07, 0.4, 0.1 * vel, bus, 0.8));
      break;
    }
  }
}
