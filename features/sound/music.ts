import { envelope, filter, hz, noiseBurst, out, pick, rand, tone, type Engine } from './engine.ts';

export type Instrument = 'pluck' | 'lute' | 'flute' | 'bell' | 'marimba';

/** A zone's musical character; the sequencer improvises within it. */
export interface Score {
  /** MIDI note of the tonic, around the lead's register. */
  root: number;
  /** Semitone offsets of the mode. */
  scale: number[];
  bpm: number;
  /** Chord tones (semitones from root), one chord per two bars. */
  chords: number[][];
  lead: Instrument;
  /** Chance per eighth note that the lead plays. */
  density: number;
  pad: number;
  bass: number;
  drums: 'none' | 'hand' | 'shaker';
  /** A held low fifth under everything, for caves and the strange places. */
  drone: number;
  /** How much of the music goes to the reverb. */
  send: number;
}

export function playLead(e: Engine, inst: Instrument, note: number, t: number, dur: number, vel: number, bus: AudioNode, send: number): void {
  const f = hz(note);
  switch (inst) {
    case 'pluck': {
      const g = envelope(e, t, 0.005, vel, 0.35 + dur);
      const lp = filter(e, 'lowpass', 2600);
      tone(e, 'triangle', f, t, 0.4 + dur, g);
      const h = envelope(e, t, 0.005, vel * 0.3, 0.2);
      tone(e, 'sine', f * 2, t, 0.3, h);
      h.connect(lp);
      g.connect(lp);
      out(e, lp, bus, send);
      break;
    }
    case 'lute': {
      const g = envelope(e, t, 0.004, vel * 0.6, 0.6 + dur * 0.5);
      const lp = filter(e, 'lowpass', 1500, 1.2);
      lp.frequency.setValueAtTime(3200, t);
      lp.frequency.exponentialRampToValueAtTime(900, t + 0.4);
      tone(e, 'sawtooth', f, t, 0.7 + dur, g);
      g.connect(lp);
      out(e, lp, bus, send);
      break;
    }
    case 'flute': {
      const g = e.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vel * 0.8, t + 0.09);
      g.gain.setValueAtTime(vel * 0.7, t + dur);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.35);
      const osc = tone(e, 'sine', f, t, dur + 0.4, g);
      const lfo = e.ctx.createOscillator();
      const depth = e.ctx.createGain();
      lfo.frequency.value = 5.2;
      depth.gain.setValueAtTime(0, t);
      depth.gain.linearRampToValueAtTime(f * 0.004, t + 0.3);
      lfo.connect(depth).connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + dur + 0.45);
      const breath = envelope(e, t, 0.02, vel * 0.05, 0.12);
      noiseBurst(e, t, 0.15, breath);
      const bp = filter(e, 'bandpass', f * 2, 2);
      breath.connect(bp);
      out(e, g, bus, send);
      out(e, bp, bus, send);
      break;
    }
    case 'bell': {
      const g = envelope(e, t, 0.003, vel * 0.7, 2.6);
      tone(e, 'sine', f, t, 2.7, g);
      const g2 = envelope(e, t, 0.003, vel * 0.22, 1.2);
      tone(e, 'sine', f * 2.76, t, 1.3, g2);
      const g3 = envelope(e, t, 0.002, vel * 0.08, 0.5);
      tone(e, 'sine', f * 5.4, t, 0.6, g3);
      out(e, g, bus, send);
      out(e, g2, bus, send);
      out(e, g3, bus, send);
      break;
    }
    case 'marimba': {
      const g = envelope(e, t, 0.003, vel, 0.5);
      tone(e, 'sine', f, t, 0.6, g);
      const g2 = envelope(e, t, 0.002, vel * 0.25, 0.12);
      tone(e, 'sine', f * 4, t, 0.15, g2);
      out(e, g, bus, send);
      out(e, g2, bus, send);
      break;
    }
  }
}

function pad(e: Engine, notes: number[], t: number, dur: number, vel: number, bus: AudioNode, send: number): void {
  const lp = filter(e, 'lowpass', 750, 0.4);
  const g = e.ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vel, t + 1.4);
  g.gain.setValueAtTime(vel, t + dur - 0.2);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 1.8);
  for (const n of notes) {
    for (const detune of [1.0035, 0.9965]) tone(e, 'sawtooth', hz(n) * detune, t, dur + 2, g);
  }
  g.connect(lp);
  out(e, lp, bus, send);
}

function bass(e: Engine, note: number, t: number, vel: number, bus: AudioNode): void {
  const g = envelope(e, t, 0.01, vel, 1.1);
  const lp = filter(e, 'lowpass', 420);
  tone(e, 'triangle', hz(note), t, 1.2, g);
  g.connect(lp);
  out(e, lp, bus);
}

function handDrum(e: Engine, t: number, vel: number, bus: AudioNode, send: number): void {
  const g = envelope(e, t, 0.002, vel, 0.28);
  const osc = tone(e, 'sine', 150, t, 0.3, g);
  osc.frequency.exponentialRampToValueAtTime(58, t + 0.2);
  out(e, g, bus, send);
}

function shaker(e: Engine, t: number, vel: number, bus: AudioNode): void {
  const g = envelope(e, t, 0.003, vel, 0.07);
  noiseBurst(e, t, 0.09, g);
  const hp = filter(e, 'highpass', 6500);
  g.connect(hp);
  out(e, hp, bus);
}

function drone(e: Engine, note: number, t: number, dur: number, vel: number, bus: AudioNode, send: number): void {
  const lp = filter(e, 'lowpass', 320, 0.5);
  const g = e.ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vel, t + 3);
  g.gain.setValueAtTime(vel, t + dur - 1);
  g.gain.linearRampToValueAtTime(0.0001, t + dur + 2);
  tone(e, 'sawtooth', hz(note), t, dur + 2.1, g);
  tone(e, 'sawtooth', hz(note + 7) * 1.002, t, dur + 2.1, g);
  g.connect(lp);
  out(e, lp, bus, send);
}

/**
 * Improvises one bar of a score starting at `t`: the pad holds a chord for
 * two bars, the bass walks the chord root, and the lead wanders the scale a
 * step or two at a time, resting now and then so it breathes.
 */
export class Improviser {
  private bar = 0;
  private last = 0;

  constructor(
    private readonly e: Engine,
    private readonly bus: AudioNode,
  ) {}

  /** Seconds this bar lasts. */
  play(s: Score, t: number, night: boolean): number {
    const { e, bus } = this;
    const beat = 60 / (night ? s.bpm * 0.88 : s.bpm);
    const chord = s.chords[(this.bar >> 1) % s.chords.length];
    if (this.bar % 2 === 0) {
      if (s.pad > 0) pad(e, chord.map((c) => s.root - 12 + c), t, beat * 8, s.pad, bus, s.send);
      if (s.drone > 0 && this.bar % 8 === 0) drone(e, s.root - 24, t, beat * 32, s.drone, bus, s.send);
    }
    if (s.bass > 0) {
      bass(e, s.root - 24 + chord[0], t, s.bass, bus);
      if (rand() < 0.5) bass(e, s.root - 24 + (chord[2] ?? chord[0]), t + beat * 2, s.bass * 0.7, bus);
    }
    if (s.drums === 'hand') {
      handDrum(e, t, 0.22, bus, s.send);
      handDrum(e, t + beat * 2.5, 0.14, bus, s.send);
      if (rand() < 0.4) handDrum(e, t + beat * 3, 0.1, bus, s.send);
    }
    if (s.drums !== 'none') for (let i = 0; i < 8; i++) shaker(e, t + i * beat * 0.5, i % 2 ? 0.02 : 0.035, bus);

    const resting = this.bar % 8 === 7 || rand() < 0.15;
    const density = night ? s.density * 0.6 : s.density;
    if (!resting) {
      for (let i = 0; i < 8; i++) {
        if (rand() > density) continue;
        this.last += pick([-2, -1, -1, 0, 1, 1, 2]);
        if (this.last < -3) this.last = -2;
        if (this.last > 9) this.last = 7;
        const degree = ((this.last % s.scale.length) + s.scale.length) % s.scale.length;
        const octave = this.last < 0 ? -12 : this.last >= s.scale.length ? 12 : 0;
        const note = s.root + s.scale[degree] + octave;
        const len = beat * 0.5 * (1 + ((rand() * 3) | 0));
        playLead(e, s.lead, note, t + i * beat * 0.5, len, 0.09 + rand() * 0.04, bus, s.send);
      }
    }
    this.bar++;
    return beat * 4;
  }
}
