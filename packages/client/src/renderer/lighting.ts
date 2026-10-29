import { Container, Graphics, RenderTexture, Sprite, Texture, type Renderer } from 'pixi.js';
import { TILE_SIZE } from '@game/shared';

/** A light in screen pixels, ready to draw. */
export interface ScreenLight {
  x: number;
  y: number;
  radius: number;
  color: number;
  flicker: number;
  intensity: number;
  seed: number;
}

export const WARM_LIGHT = 0xffb055;

let falloff: Texture | null = null;

/** White at the centre fading to nothing at the rim, eased so edges stay soft. */
function falloffTexture(): Texture {
  if (falloff) return falloff;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.65, 'rgba(255,255,255,0.4)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  falloff = Texture.from(canvas);
  return falloff;
}

function hash01(n: number): number {
  let h = (n * 374761393) | 0;
  h = imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function imul(a: number, b: number): number {
  return ((a & 0xffff) * b + ((((a >>> 16) * b) & 0xffff) << 16)) | 0;
}

/** Smooth value noise in 0..1. */
function noise(t: number, seed: number): number {
  const i = t | 0;
  const f = t - i;
  const s = f * f * (3 - 2 * f);
  const a = hash01(i * 7919 + seed);
  const b = hash01((i + 1) * 7919 + seed);
  return a + (b - a) * s;
}

/**
 * Night and caves. The dark is drawn into a screen-sized texture each frame
 * and every light erases a soft disc out of it, so overlapping lights merge
 * instead of stacking dark rings. A second, additive pass tints the ground
 * around each light with its colour.
 */
export class LightingRenderer {
  private readonly sources = new Map<string, { level: number; tint: number }>();
  private readonly mask = new Container();
  private readonly shade = new Graphics();
  private readonly holes: Sprite[] = [];
  private readonly glows: Sprite[] = [];
  private readonly glowLayer = new Container();
  private readonly view: Sprite;
  private target: RenderTexture;
  private w = 0;
  private h = 0;

  constructor(
    private readonly renderer: Renderer,
    stage: Container,
  ) {
    this.target = RenderTexture.create({ width: 1, height: 1 });
    this.view = new Sprite(this.target);
    this.view.eventMode = 'none';
    this.glowLayer.eventMode = 'none';
    this.mask.addChild(this.shade);
    stage.addChild(this.glowLayer, this.view);
  }

  setDarkness(source: string, level: number, tint = 0x0a0e22): void {
    if (level <= 0) this.sources.delete(source);
    else this.sources.set(source, { level: level > 1 ? 1 : level, tint });
  }

  /** The darkest source's level and tint. */
  private ambient(): { level: number; tint: number } {
    let best = { level: 0, tint: 0 };
    for (const s of this.sources.values()) if (s.level > best.level) best = s;
    return best;
  }

  get dark(): number {
    return this.ambient().level;
  }

  update(viewW: number, viewH: number, lights: ScreenLight[], now: number): void {
    const { level, tint } = this.ambient();
    const on = level > 0.01;
    this.view.visible = on;
    this.glowLayer.visible = on;
    if (!on) return;

    if (viewW !== this.w || viewH !== this.h) {
      this.w = viewW;
      this.h = viewH;
      this.target.destroy(true);
      this.target = RenderTexture.create({ width: viewW, height: viewH });
      this.view.texture = this.target;
    }

    this.shade.clear().rect(0, 0, viewW, viewH).fill({ color: tint, alpha: level });

    const tex = falloffTexture();
    const t = now / 1000;
    let n = 0;
    for (const light of lights) {
      const r = light.radius * TILE_SIZE;
      if (light.x + r < 0 || light.y + r < 0 || light.x - r > viewW || light.y - r > viewH)
        continue;
      const wobble = light.flicker > 0 ? (noise(t * 7, light.seed) - 0.5) * light.flicker : 0;
      const size = r * 2 * (1 + wobble * 0.18);

      let hole = this.holes[n];
      let glow = this.glows[n];
      if (!hole) {
        hole = new Sprite(tex);
        hole.anchor.set(0.5);
        hole.blendMode = 'erase';
        this.holes.push(hole);
        this.mask.addChild(hole);
        glow = new Sprite(tex);
        glow.anchor.set(0.5);
        glow.blendMode = 'add';
        this.glows.push(glow);
        this.glowLayer.addChild(glow);
      }
      hole.visible = true;
      hole.position.set(light.x, light.y);
      hole.width = size;
      hole.height = size;
      hole.alpha = 0.9 * light.intensity * (1 + wobble * 0.25);

      glow.visible = true;
      glow.position.set(light.x, light.y);
      glow.width = size * 0.7;
      glow.height = size * 0.7;
      glow.tint = light.color;
      glow.alpha = 0.3 * level * light.intensity * (1 + wobble * 0.5);
      n++;
    }
    for (let i = n; i < this.holes.length; i++) {
      this.holes[i].visible = false;
      this.glows[i].visible = false;
    }

    this.renderer.render({
      container: this.mask,
      target: this.target,
      clear: true,
      clearColor: [0, 0, 0, 0],
    });
  }
}
