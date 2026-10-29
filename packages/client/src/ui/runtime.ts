import { useEffect, useReducer } from 'react';
import type { ClientAPI, ClientWindow, EntityState, Intent, LogTone } from '@game/shared';
import type { Game } from '../game.ts';
import { emojiForItem } from '../emoji-atlas.ts';
import { getItemDef } from '../items.ts';
import type { Controls } from '../controls.ts';

export type Tone = LogTone;

export interface LogLine {
  id: number;
  text: string;
  tone: Tone;
  at: number;
  speaker?: string;
}

export interface Banner {
  id: number;
  text: string;
  sub?: string;
  kind: 'level' | 'death' | 'info';
}

type Listener = () => void;

/**
 * The HUD's shared state: the message log, banners, which windows are
 * open, and the ClientAPI handed to feature UI. One instance per page.
 */
export class HudRuntime {
  readonly log: LogLine[] = [];
  banner: Banner | null = null;
  readonly open = new Set<string>();
  readonly windows = new Map<string, ClientWindow & { id: string }>();
  readonly client: ClientAPI;
  private readonly listeners = new Set<Listener>();
  private readonly uiListeners = new Set<Listener>();
  private seq = 0;

  constructor(
    readonly game: Game,
    readonly controls: Controls,
    readonly sendIntent: (intent: Intent) => void,
  ) {
    game.onSnapshot(() => {
      for (const l of this.listeners) l();
    });
    this.client = {
      localPlayer: () => game.localPlayer(),
      entity: (id) => game.entity(id),
      entities: () => game.entities(),
      itemDef: (id) => getItemDef(id),
      itemIcon: (id) => emojiForItem(id, getItemDef(id)?.tags),
      subscribe: (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      sendIntent: (intent) => sendIntent(intent as Intent),
      notify: (text, tone, speaker) => this.notify(text, tone ?? 'info', speaker),
      screenOf: (id) => game.screenOf(id),
      target: () => controls.view.targetId,
      toggleWindow: (id, open) => this.toggle(id, open),
      banner: (text, sub, kind) => this.showBanner(text, kind ?? 'info', sub),
      setDarkness: (source, level, tint) => game.setDarkness(source, level, tint),
    };
  }

  notify(text: string, tone: Tone = 'info', speaker?: string): void {
    const last = this.log[this.log.length - 1];
    if (
      !speaker &&
      last &&
      last.text === text &&
      !last.speaker &&
      performance.now() - last.at < 1500
    ) {
      return;
    }
    this.log.push({ id: ++this.seq, text, tone, at: performance.now(), speaker });
    if (this.log.length > 100) this.log.shift();
    this.changed();
  }

  showBanner(text: string, kind: Banner['kind'], sub?: string): void {
    this.banner = { id: ++this.seq, text, kind, sub };
    this.changed();
  }

  toggle(id: string, open?: boolean): void {
    const next = open ?? !this.open.has(id);
    if (next) this.open.add(id);
    else this.open.delete(id);
    this.changed();
  }

  onSnapshot(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onChange(listener: Listener): () => void {
    this.uiListeners.add(listener);
    return () => this.uiListeners.delete(listener);
  }

  changed(): void {
    for (const l of this.uiListeners) l();
  }
}

/** Re-render on every snapshot. */
export function useSnapshots(rt: HudRuntime): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => rt.onSnapshot(force), [rt]);
}

/** Re-render on HUD state changes (log, windows, banners). */
export function useHudState(rt: HudRuntime): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => rt.onChange(force), [rt]);
}

/** Re-render on a fixed cadence, for things that follow the mouse or camera. */
export function useFrame(ms: number): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const id = window.setInterval(force, ms);
    return () => window.clearInterval(id);
  }, [ms]);
}

export function componentOf<T>(entity: EntityState | undefined, key: string): T | undefined {
  const value = entity?.components[key];
  return typeof value === 'object' && value !== null ? (value as T) : undefined;
}
