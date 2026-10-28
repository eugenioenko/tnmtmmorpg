import { useEffect, type ReactElement } from 'react';
import type { ClientAPI } from '@game/shared';
import { portraitFrame } from '../art.ts';
import { HudChrome, Portrait, quickSlots, useItem, type DevPanel } from './Hud.tsx';
import { InventoryPanel } from './InventoryPanel.tsx';
import { RecipePanel } from './RecipePanel.tsx';
import { componentOf, useHudState, useSnapshots, type HudRuntime } from './runtime.ts';
import './hud.css';

/** A dev panel from a feature: rendered in the F3 drawer. */
export type FeaturePanel = DevPanel;

export type FeatureComponent = (props: { client: ClientAPI }) => ReactElement | null;

interface DialogOption {
  label: string;
  intent?: { kind: string; [key: string]: unknown };
  note?: string;
  disabled?: boolean;
}

interface DialogView {
  npcId?: number;
  name?: string;
  text: string;
  options: DialogOption[];
  closeIntent?: string;
}

function isDialog(value: unknown): value is DialogView {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  return typeof d.text === 'string' && Array.isArray(d.options);
}

function chooseOption(rt: HudRuntime, option: DialogOption | undefined): void {
  if (!option || option.disabled || !option.intent) return;
  rt.sendIntent({ t: 'intent', ...option.intent });
}

function closeDialog(rt: HudRuntime, dialog: DialogView): void {
  if (dialog.closeIntent) rt.sendIntent({ t: 'intent', kind: dialog.closeIntent });
}

/**
 * Conversation box for the local player's `dialog` component. Any feature
 * can open one by writing that component; the options carry the intents
 * they send, so the box itself knows nothing about shops or quests.
 */
function DialogBox({ rt }: { rt: HudRuntime }) {
  useSnapshots(rt);
  const dialog = rt.game.localPlayer()?.components.dialog;
  if (!isDialog(dialog)) return null;
  const speaker = dialog.npcId !== undefined ? rt.game.entity(dialog.npcId) : undefined;
  return (
    <div className="dialog frame" onPointerDown={(e) => e.stopPropagation()}>
      <Portrait frame={speaker ? portraitFrame(speaker) : undefined} size={72} />
      <div className="dialog-main">
        <div className="dialog-name">{dialog.name ?? 'Stranger'}</div>
        <div className="dialog-text">{dialog.text}</div>
        <div className="dialog-options">
          {dialog.options.map((option, i) => (
            <button
              key={`${i}-${option.label}`}
              type="button"
              className={`dialog-option${option.disabled ? ' disabled' : ''}`}
              onClick={(e) => {
                e.currentTarget.blur();
                chooseOption(rt, option);
              }}
            >
              <span className="num">{i + 1}.</span>
              {option.label}
              {option.note && <span className="price">{option.note}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Windows({ rt }: { rt: HudRuntime }) {
  useHudState(rt);
  const open = [...rt.windows.values()]
    .filter((w) => rt.open.has(w.id))
    .sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  return (
    <div className="windows">
      {open.map((w) => {
        const Body = w.component as (props: { client: ClientAPI }) => ReactElement | null;
        return (
          <div
            key={w.id}
            className="window frame"
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <div className="window-title">
              <span>{w.icon}</span>
              <span>{w.title}</span>
              <span className="spacer" />
              <button type="button" className="close-btn" onClick={() => rt.toggle(w.id, false)}>
                ✕
              </button>
            </div>
            <div className="window-body">
              <Body client={rt.client} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function useHotkeys(rt: HudRuntime): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof Element && e.target.closest('input, textarea')) return;
      if (e.repeat) return;
      const me = rt.game.localPlayer();
      const dialog = me?.components.dialog;
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (isDialog(dialog)) {
        if (digit) {
          e.preventDefault();
          chooseOption(rt, dialog.options[Number(digit[1]) - 1]);
          return;
        }
        if (e.code === 'Escape') {
          closeDialog(rt, dialog);
          return;
        }
      }
      if (digit) {
        const q = quickSlots(me)[Number(digit[1]) - 1];
        if (q) useItem(rt, q.itemId, q.slot);
        return;
      }
      if (e.code === 'F3' || e.code === 'Backquote') {
        e.preventDefault();
        rt.toggle('debug');
        return;
      }
      if (e.code === 'Escape' && rt.open.size > 0) {
        rt.open.clear();
        rt.changed();
        return;
      }
      for (const w of rt.windows.values()) {
        if (w.hotkey === e.code) {
          e.preventDefault();
          rt.toggle(w.id);
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rt]);
}

/** Watches the local player for changes worth a log line or a banner. */
function useCoreNotices(rt: HudRuntime): void {
  useEffect(() => {
    let lastLevel: number | null = null;
    let lastId: number | null = null;
    return rt.onSnapshot(() => {
      const me = rt.game.localPlayer();
      if (!me) return;
      const stats = componentOf<{ level: number }>(me, 'stats');
      if (me.id !== lastId) {
        lastId = me.id;
        lastLevel = stats?.level ?? null;
        return;
      }
      if (stats && lastLevel !== null && stats.level > lastLevel) {
        rt.showBanner(`Level ${stats.level}`, 'level', 'You feel stronger.');
      }
      lastLevel = stats?.level ?? lastLevel;
    });
  }, [rt]);
}

export function App({
  rt,
  devPanels,
  hudWidgets,
  overlays,
}: {
  rt: HudRuntime;
  devPanels: Record<string, DevPanel>;
  hudWidgets: Record<string, FeatureComponent>;
  overlays: Record<string, FeatureComponent>;
}) {
  useHotkeys(rt);
  useCoreNotices(rt);
  return (
    <div className="hud">
      <HudChrome rt={rt} devPanels={devPanels} hudWidgets={hudWidgets} overlays={overlays} />
      <Windows rt={rt} />
      <DialogBox rt={rt} />
    </div>
  );
}

/** Core windows, registered alongside the features' own. */
export function registerCoreWindows(rt: HudRuntime): void {
  rt.windows.set('inventory', {
    id: 'inventory',
    title: 'Inventory',
    icon: '🎒',
    hotkey: 'KeyI',
    order: 10,
    component: () => <InventoryPanel rt={rt} />,
  });
  rt.windows.set('crafting', {
    id: 'crafting',
    title: 'Crafting',
    icon: '⚒️',
    hotkey: 'KeyK',
    order: 40,
    component: () => <RecipePanel rt={rt} />,
  });
}
