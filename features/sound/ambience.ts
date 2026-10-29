import { envelope, filter, noiseBurst, out, rand, tone, type Engine } from './engine.ts';

export type Call =
  | 'bird'
  | 'cricket'
  | 'owl'
  | 'frog'
  | 'woodpecker'
  | 'drip'
  | 'crackle'
  | 'gull'
  | 'rumble'
  | 'thunder';

/** A one-off sound out in the world, scheduled at `t`. */
export function call(e: Engine, kind: Call, t: number, bus: AudioNode, vel = 1): void {
  switch (kind) {
    case 'bird': {
      const notes = 2 + ((rand() * 4) | 0);
      const base = 2400 + rand() * 1400;
      for (let i = 0; i < notes; i++) {
        const at = t + i * (0.09 + rand() * 0.05);
        const g = envelope(e, at, 0.01, 0.035 * vel, 0.08);
        const osc = tone(e, 'sine', base * (0.9 + rand() * 0.3), at, 0.1, g);
        osc.frequency.exponentialRampToValueAtTime(base * (rand() < 0.5 ? 1.35 : 0.75), at + 0.07);
        out(e, g, bus, 0.15);
      }
      break;
    }
    case 'cricket': {
      const f = 4300 + rand() * 600;
      for (let i = 0; i < 4; i++) {
        const at = t + i * 0.075;
        const g = envelope(e, at, 0.004, 0.012 * vel, 0.035);
        tone(e, 'sine', f, at, 0.05, g);
        out(e, g, bus);
      }
      break;
    }
    case 'owl': {
      for (const [dt, f] of [[0, 410], [0.45, 380], [0.75, 370]] as const) {
        const g = envelope(e, t + dt, 0.06, 0.05 * vel, 0.3);
        const osc = tone(e, 'sine', f, t + dt, 0.4, g);
        osc.frequency.linearRampToValueAtTime(f * 0.93, t + dt + 0.3);
        out(e, g, bus, 0.5);
      }
      break;
    }
    case 'frog': {
      const g = e.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      const pulses = 6 + ((rand() * 5) | 0);
      for (let i = 0; i < pulses; i++) {
        g.gain.linearRampToValueAtTime(0.05 * vel, t + i * 0.035 + 0.008);
        g.gain.linearRampToValueAtTime(0.0001, t + i * 0.035 + 0.03);
      }
      tone(e, 'sawtooth', 95 + rand() * 50, t, pulses * 0.035 + 0.05, g);
      const bp = filter(e, 'bandpass', 520, 3);
      g.connect(bp);
      out(e, bp, bus, 0.2);
      break;
    }
    case 'woodpecker': {
      const hits = 8 + ((rand() * 6) | 0);
      for (let i = 0; i < hits; i++) {
        const g = envelope(e, t + i * 0.055, 0.001, 0.06 * vel, 0.025);
        noiseBurst(e, t + i * 0.055, 0.03, g);
        const bp = filter(e, 'bandpass', 1300, 4);
        g.connect(bp);
        out(e, bp, bus, 0.3);
      }
      break;
    }
    case 'drip': {
      const g = envelope(e, t, 0.002, 0.07 * vel, 0.09);
      const osc = tone(e, 'sine', 1500 + rand() * 900, t, 0.1, g);
      osc.frequency.exponentialRampToValueAtTime(500, t + 0.06);
      out(e, g, bus, 0.9);
      break;
    }
    case 'crackle': {
      const pops = 3 + ((rand() * 6) | 0);
      for (let i = 0; i < pops; i++) {
        const at = t + rand() * 0.5;
        const g = envelope(e, at, 0.001, (0.03 + rand() * 0.05) * vel, 0.012 + rand() * 0.02);
        noiseBurst(e, at, 0.04, g);
        const bp = filter(e, 'bandpass', 1500 + rand() * 2500, 1.5);
        g.connect(bp);
        out(e, bp, bus);
      }
      break;
    }
    case 'gull': {
      const g = envelope(e, t, 0.03, 0.04 * vel, 0.35);
      const osc = tone(e, 'triangle', 1500, t, 0.4, g);
      osc.frequency.linearRampToValueAtTime(1050, t + 0.32);
      const bp = filter(e, 'bandpass', 1300, 1.5);
      g.connect(bp);
      out(e, bp, bus, 0.4);
      break;
    }
    case 'thunder': {
      const crack = envelope(e, t, 0.004, 0.35 * vel, 0.35);
      noiseBurst(e, t, 0.4, crack);
      const hp = filter(e, 'bandpass', 1600, 0.6);
      crack.connect(hp);
      out(e, hp, bus, 0.6);
      const roll = e.ctx.createGain();
      roll.gain.setValueAtTime(0.0001, t);
      roll.gain.linearRampToValueAtTime(1.1 * vel, t + 0.25);
      for (let i = 1; i < 6; i++) roll.gain.linearRampToValueAtTime((0.4 + rand() * 0.6) * vel, t + 0.25 + i * (0.35 + rand() * 0.3));
      roll.gain.exponentialRampToValueAtTime(0.0001, t + 5.5);
      noiseBurst(e, t, 5.6, roll);
      const lp = filter(e, 'lowpass', 160, 0.8);
      roll.connect(lp);
      out(e, lp, bus, 0.5);
      break;
    }
    case 'rumble': {
      const g = envelope(e, t, 0.6, 0.18 * vel, 2.2);
      noiseBurst(e, t, 3, g);
      const lp = filter(e, 'lowpass', 110);
      g.connect(lp);
      out(e, lp, bus, 0.3);
      break;
    }
  }
}

/**
 * A continuous bed of filtered noise (wind, surf, rain), whose level and colour
 * drift every few seconds so it never sounds like a loop. `set` glides to a
 * new level; zero lets it fall silent.
 */
export class Bed {
  private readonly gain: GainNode;
  private readonly band: BiquadFilterNode;
  private level = 0;
  private nextDrift = 0;

  constructor(
    e: Engine,
    bus: AudioNode,
    private readonly kind: 'wind' | 'surf' | 'rain',
  ) {
    const src = e.ctx.createBufferSource();
    src.buffer = e.noise;
    src.loop = true;
    this.band =
      kind === 'wind' ? filter(e, 'bandpass', 500, 0.8) : kind === 'rain' ? filter(e, 'bandpass', 2400, 0.35) : filter(e, 'lowpass', 600, 0.5);
    this.gain = e.ctx.createGain();
    this.gain.gain.value = 0;
    src.connect(this.band).connect(this.gain).connect(bus);
    src.start();
  }

  set(level: number): void {
    this.level = level;
  }

  /** Called a few times a second with the context's clock. */
  update(t: number): void {
    if (t < this.nextDrift) return;
    const surf = this.kind === 'surf';
    const rain = this.kind === 'rain';
    const span = surf ? 3 + rand() * 4 : 2 + rand() * 3;
    this.nextDrift = t + span;
    const swell = surf ? 0.35 + rand() * 0.65 : rain ? 0.85 + rand() * 0.15 : 0.55 + rand() * 0.45;
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setValueAtTime(this.gain.gain.value, t);
    this.gain.gain.linearRampToValueAtTime(this.level * swell, t + span * 0.6);
    if (surf) this.gain.gain.linearRampToValueAtTime(this.level * 0.25, t + span);
    const f = surf ? 400 + rand() * 500 : rain ? 1900 + rand() * 1200 : 300 + rand() * 700;
    this.band.frequency.cancelScheduledValues(t);
    this.band.frequency.setValueAtTime(this.band.frequency.value, t);
    this.band.frequency.linearRampToValueAtTime(f, t + span);
  }
}
