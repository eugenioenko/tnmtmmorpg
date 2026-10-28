import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import type { EntityState, InventoryComponent, StatsComponent } from '@game/shared';
import { isStatsComponent, resolveWorld } from '@game/shared';
import { portraitFrame, type PortraitFrame } from '../art.ts';
import { actionFor, entityName } from '../interactions.ts';
import { isHostile } from '../controls.ts';
import { getItemDef } from '../items.ts';
import { componentOf, useFrame, useHudState, useSnapshots, type HudRuntime } from './runtime.ts';
import { ItemIcon } from './ItemIcon.tsx';

interface CharacterView {
  name?: string;
  xp?: number;
  xpNext?: number;
  xpPrev?: number;
  gold?: number;
}

export function Portrait({ frame, size }: { frame: PortraitFrame | undefined; size: number }) {
  if (!frame) return <div className="portrait" style={{ width: size, height: size }} />;
  const scale = ((size - 8) / (frame.h > frame.w ? frame.h : frame.w)) * 1.15;
  const style: CSSProperties = {
    width: frame.w,
    height: frame.h,
    backgroundImage: `url(${frame.url})`,
    backgroundPosition: `-${frame.x}px -${frame.y}px`,
    transform: `translateX(-50%) scale(${scale})`,
    filter: frame.tint ? tintFilter(frame.tint) : undefined,
  };
  return (
    <div className="portrait" style={{ width: size, height: size }}>
      <div className="sprite" style={style} />
    </div>
  );
}

function tintFilter(tint: number): string {
  const r = (tint >> 16) & 255;
  const g = (tint >> 8) & 255;
  const b = tint & 255;
  const hue = r > g && r > b ? -20 : b > r && b > g ? 180 : g > r ? 70 : 0;
  return `sepia(0.6) hue-rotate(${hue}deg) saturate(1.4) brightness(${(r + g + b) / 600 + 0.5})`;
}

function Bar({
  value,
  max,
  className,
  label,
}: {
  value: number;
  max: number;
  className: string;
  label?: string;
}) {
  const frac = max > 0 ? (value < 0 ? 0 : value > max ? 1 : value / max) : 0;
  return (
    <div className={`bar ${className}`}>
      <div className="ghost" style={{ width: `${frac * 100}%` }} />
      <div className="fill" style={{ width: `${frac * 100}%` }} />
      {label && <div className="label">{label}</div>}
    </div>
  );
}

function PlayerFrame({ rt }: { rt: HudRuntime }) {
  useSnapshots(rt);
  const me = rt.game.localPlayer();
  if (!me) return null;
  const stats = me.components.stats as StatsComponent | undefined;
  const ch = componentOf<CharacterView>(me, 'character');
  const hp = stats?.hp ?? 0;
  const maxHp = stats?.maxHp ?? 1;
  const xpPrev = ch?.xpPrev ?? 0;
  return (
    <div className="player-frame frame interactive">
      <Portrait frame={portraitFrame(me)} size={58} />
      <div className="level-badge">{stats?.level ?? 1}</div>
      <div className="player-info">
        <div className="player-name">
          <span>{ch?.name ?? entityName(me)}</span>
          {ch?.gold !== undefined && <span className="gold-count">◉ {ch.gold}</span>}
        </div>
        <Bar value={hp} max={maxHp} className="hp" label={`${hp} / ${maxHp}`} />
        {ch?.xp !== undefined && ch.xpNext !== undefined && (
          <Bar value={ch.xp - xpPrev} max={ch.xpNext - xpPrev} className="xp" />
        )}
        {stats && (
          <div className="stat-chips">
            <span>
              ATK <b>{stats.atk}</b>
            </span>
            <span>
              DEF <b>{stats.def}</b>
            </span>
            {ch?.xp !== undefined && ch.xpNext !== undefined && (
              <span>
                XP <b>{ch.xp - xpPrev}</b>/{ch.xpNext - xpPrev}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TargetFrame({ rt }: { rt: HudRuntime }) {
  useSnapshots(rt);
  useFrame(150);
  const id = rt.controls.view.targetId;
  const target = id === null ? undefined : rt.game.entity(id);
  if (!target) return null;
  const stats = target.components.stats;
  const hostile = isHostile(target);
  const species = componentOf<{ title?: string }>(target, 'monster')?.title;
  return (
    <div className="target-frame frame interactive">
      <div className={`target-name${hostile ? ' hostile' : ''}`}>{entityName(target)}</div>
      <div className="target-sub">
        {isStatsComponent(stats) ? `Level ${stats.level}` : ''}
        {species ? ` · ${species}` : hostile ? ' · Hostile' : ''}
      </div>
      {isStatsComponent(stats) && (
        <Bar
          value={stats.hp}
          max={stats.maxHp}
          className={`hp${hostile ? ' enemy' : ''}`}
          label={`${stats.hp} / ${stats.maxHp}`}
        />
      )}
    </div>
  );
}

const MINI_COLORS: Record<string, string> = {
  grass: '#4f8a35',
  forest: '#2e5a29',
  water: '#2f5f9e',
  sand: '#cdb67c',
  mountain: '#6f675e',
  dirt: '#8d6a43',
  snow: '#dfe7ec',
  swamp: '#4b5a36',
  void: '#000000',
  floor: '#6b5a48',
  wall: '#2e251e',
};

const MINI_SCALE = 3;

function Minimap({ rt }: { rt: HudRuntime }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [caption, setCaption] = useState({ world: '', x: 0, y: 0 });
  useEffect(() => {
    const draw = (): void => {
      const canvas = ref.current;
      const me = rt.game.localPlayer();
      if (!canvas || !me) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const size = canvas.width;
      const half = size / MINI_SCALE / 2;
      const center = rt.game.visualTile(me.id) ?? { x: me.x, y: me.y };
      const ox = center.x - half;
      const oy = center.y - half;
      const x0 = ox | 0;
      const y0 = oy | 0;
      const fx = (ox - x0) * MINI_SCALE;
      const fy = (oy - y0) * MINI_SCALE;
      for (let ty = 0; ty <= half * 2 + 1; ty++) {
        for (let tx = 0; tx <= half * 2 + 1; tx++) {
          ctx.fillStyle = MINI_COLORS[rt.game.tileKind(x0 + tx, y0 + ty)] ?? '#4f8a35';
          ctx.fillRect(tx * MINI_SCALE - fx, ty * MINI_SCALE - fy, MINI_SCALE, MINI_SCALE);
        }
      }
      for (const e of rt.game.entities()) {
        if (e.id === me.id) continue;
        const v = rt.game.visualTile(e.id) ?? e;
        const px = (v.x - ox) * MINI_SCALE;
        const py = (v.y - oy) * MINI_SCALE;
        if (px < 0 || py < 0 || px > size || py > size) continue;
        let color: string | null = null;
        let r = 1.6;
        if (e.kind === 'player') color = '#6fb6ff';
        else if (isHostile(e)) color = '#ff5a4e';
        else if (e.components.dialogue !== undefined || e.components.interact !== undefined) {
          color = '#ffd25e';
          r = 2.4;
        } else if (actionFor(e, me.id).type === 'interact') {
          color = '#f3e6c8';
          r = 2;
        } else if (e.kind === 'npc') color = '#b6e38f';
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, 6.2832);
        ctx.fill();
      }
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#000';
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, 3, 0, 6.2832);
      ctx.fill();
      ctx.stroke();
      const world = rt.game.state.world;
      setCaption((c) =>
        c.world === world && c.x === me.x && c.y === me.y ? c : { world, x: me.x, y: me.y },
      );
    };
    const id = window.setInterval(draw, 120);
    return () => window.clearInterval(id);
  }, [rt]);
  const spec = resolveWorld(caption.world);
  const name = caption.world.startsWith('interior:')
    ? 'Indoors'
    : (spec?.name ?? caption.world).replace(/^The /, '');
  return (
    <div className="minimap frame interactive">
      <canvas ref={ref} width={160} height={160} />
      <div className="minimap-caption">{name}</div>
      <div className="minimap-coords">
        {caption.x}, {caption.y}
      </div>
    </div>
  );
}

function MessageLog({ rt }: { rt: HudRuntime }) {
  useHudState(rt);
  useFrame(1000);
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const now = performance.now();
  const newest = rt.log[rt.log.length - 1]?.id;
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [newest]);
  return (
    <div
      ref={ref}
      className="log"
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
      }}
    >
      {rt.log.map((line) => (
        <div key={line.id} className={`log-line ${line.tone}${now - line.at > 20000 ? ' old' : ''}`}>
          {line.speaker && <span className="speaker">{line.speaker}</span>}
          {line.text}
        </div>
      ))}
    </div>
  );
}

function isInventory(value: unknown): value is InventoryComponent {
  if (typeof value !== 'object' || value === null) return false;
  const inv = value as Record<string, unknown>;
  return Array.isArray(inv.slots) && typeof inv.capacity === 'number';
}

/** Consumables in the pack, one quick slot per item kind, in pack order. */
export function quickSlots(me: EntityState | undefined): { itemId: string; slot: number; count: number }[] {
  const inv = me?.components.inventory;
  if (!isInventory(inv)) return [];
  const out: { itemId: string; slot: number; count: number }[] = [];
  inv.slots.forEach((s, slot) => {
    if (s.count <= 0) return;
    const def = getItemDef(s.itemId);
    if (!def?.use || !def.tags.includes('consumable')) return;
    const existing = out.find((q) => q.itemId === s.itemId);
    if (existing) existing.count += s.count;
    else if (out.length < 6) out.push({ itemId: s.itemId, slot, count: s.count });
  });
  return out;
}

export function useItem(rt: HudRuntime, itemId: string, slot: number): void {
  const def = getItemDef(itemId);
  if (def?.use) rt.sendIntent({ t: 'intent', kind: def.use, slot });
}

function ActionBar({ rt }: { rt: HudRuntime }) {
  useSnapshots(rt);
  useHudState(rt);
  const me = rt.game.localPlayer();
  const quick = quickSlots(me);
  const buttons = [...rt.windows.values()].filter((w) => w.onBar !== false).sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  return (
    <div className="action-bar frame interactive">
      <div className="slot-row">
        {[0, 1, 2, 3, 4, 5].map((i) => {
          const q = quick[i];
          const def = q ? getItemDef(q.itemId) : undefined;
          return (
            <button
              key={i}
              type="button"
              className={`slot${q ? '' : ' empty'}`}
              title={def ? `${def.name} — ${def.useLabel ?? 'Use'} (${i + 1})` : 'Empty slot'}
              onClick={(e) => {
                e.currentTarget.blur();
                if (q) useItem(rt, q.itemId, q.slot);
              }}
            >
              <span className="key">{i + 1}</span>
              {q && <ItemIcon itemId={q.itemId} size={26} />}
              {q && q.count > 1 && <span className="count">{q.count}</span>}
            </button>
          );
        })}
      </div>
      <div className="menu-row">
        <button
          type="button"
          className={`menu-btn${rt.controls.view.running ? ' active' : ''}`}
          title={rt.controls.view.running ? 'Running — click or Z to walk (hold Shift to walk for now)' : 'Walking — click or Z to run (hold Shift to run for now)'}
          onClick={(e) => {
            e.currentTarget.blur();
            rt.controls.toggleRun();
          }}
        >
          {rt.controls.view.running ? '🏃' : '🚶'}
          <span className="key">Z</span>
        </button>
        {buttons.map((w) => (
          <button
            key={w.id}
            type="button"
            className={`menu-btn${rt.open.has(w.id) ? ' active' : ''}`}
            title={`${w.title}${w.hotkey ? ` (${w.hotkey.replace('Key', '')})` : ''}`}
            onClick={(e) => {
              e.currentTarget.blur();
              rt.toggle(w.id);
            }}
          >
            {w.icon}
            {w.hotkey && <span className="key">{w.hotkey.replace('Key', '')}</span>}
          </button>
        ))}
        <button
          type="button"
          className={`menu-btn${rt.open.has('debug') ? ' active' : ''}`}
          title="Developer tools (F3)"
          onClick={(e) => {
            e.currentTarget.blur();
            rt.toggle('debug');
          }}
        >
          ⚙
          <span className="key">F3</span>
        </button>
      </div>
    </div>
  );
}

function PromptLine({ rt }: { rt: HudRuntime }) {
  useSnapshots(rt);
  const me = rt.game.localPlayer();
  const prompt = rt.controls.view.prompt;
  if (!me || !prompt || me.components.dialog) return null;
  return (
    <div className="prompt">
      <kbd>{prompt.key}</kbd>
      {prompt.verb} <b>{prompt.name}</b>
    </div>
  );
}

function HoverTip({ rt }: { rt: HudRuntime }) {
  useFrame(60);
  const { hoveredId, mouseX, mouseY } = rt.controls.view;
  const entity = hoveredId === null ? undefined : rt.game.entity(hoveredId);
  const me = rt.game.localPlayer();
  if (!entity || !me || entity.id === me.id) return null;
  const action = actionFor(entity, me.id);
  const hostile = isHostile(entity);
  const stats = entity.components.stats;
  const friendly = action.type === 'interact' && entity.kind === 'npc';
  let verb = '';
  if (action.type === 'attack') verb = hostile ? 'Click to attack' : 'Click to attack (provokes)';
  else if (action.type === 'interact') {
    verb = `Click to ${action.interaction.label.toLowerCase().replace(/ to$/, '')}`;
  }
  else if (action.type === 'pickup') verb = 'Click to pick up';
  return (
    <div className="hover-tip" style={{ left: mouseX, top: mouseY }}>
      <div className={`name${hostile ? ' hostile' : friendly ? ' friendly' : ''}`}>
        {entityName(entity)}
      </div>
      {isStatsComponent(stats) && (
        <div className="sub">
          Level {stats.level} · {stats.hp}/{stats.maxHp} HP
        </div>
      )}
      {verb && <div className="verb">{verb}</div>}
    </div>
  );
}

function Banners({ rt }: { rt: HudRuntime }) {
  useHudState(rt);
  useSnapshots(rt);
  const banner = rt.banner;
  const me = rt.game.localPlayer();
  const stats = me?.components.stats;
  const low = isStatsComponent(stats) && stats.hp > 0 && stats.hp / stats.maxHp < 0.3;
  return (
    <>
      {low && <div className="low-hp" />}
      {banner && (
        <div key={banner.id} className={`center-banner ${banner.kind}`}>
          {banner.text}
          {banner.sub && <span className="sub">{banner.sub}</span>}
        </div>
      )}
      {banner?.kind === 'death' && <div key={`v${banner.id}`} className="vignette" />}
    </>
  );
}

function ConnectionOverlay({ rt }: { rt: HudRuntime }) {
  useFrame(500);
  if (rt.game.state.connected && rt.game.state.localEntityId !== null) return null;
  return <div className="disconnected">Reconnecting to the realm…</div>;
}

function FeatureBanner({ rt }: { rt: HudRuntime }) {
  useFrame(1000);
  const disabled = rt.game.state.disabledFeatures;
  if (disabled.length === 0) return null;
  return (
    <div className="feature-banner">
      {disabled.map((name) => (
        <div key={name}>FEATURE SYSTEM DISABLED: {name} — it will not run until the server restarts</div>
      ))}
    </div>
  );
}

export type DevPanel = (props: { sendIntent: HudRuntime['sendIntent'] }) => ReactElement;

function DebugDrawer({ rt, devPanels }: { rt: HudRuntime; devPanels: Record<string, DevPanel> }) {
  useHudState(rt);
  useFrame(250);
  const s = rt.game.state;
  const open = rt.open.has('debug');
  return (
    <div className="debug-drawer frame" style={{ display: open ? undefined : 'none' }}>
      <h4>Connection</h4>
      <div className="debug-grid">
        <span>status</span>
        <span className={s.connected ? 'conn-on' : 'conn-off'}>{s.connected ? 'connected' : 'offline'}</span>
        <span>entity</span>
        <span>{s.localEntityId ?? '–'}</span>
        <span>pos</span>
        <span>
          {s.playerX}, {s.playerY}
        </span>
        <span>world</span>
        <span>{s.world}</span>
        <span>tick</span>
        <span>{s.tick}</span>
        <span>ping</span>
        <span>{s.pingMs} ms</span>
        <span>entities</span>
        <span>{s.entityCount}</span>
        <span>fps</span>
        <span>{s.fps}</span>
      </div>
      <h4>Controls</h4>
      <div className="hint">
        Alt+WASD: 100-tile stride · Z: run/walk (Shift inverts while held) · Tab: target enemy · Esc: cancel · F3: this drawer
      </div>
      <h4>Feature tools</h4>
      {Object.entries(devPanels).map(([id, Panel]) => (
        <Panel key={id} sendIntent={rt.sendIntent} />
      ))}
    </div>
  );
}

type Widget = (props: { client: HudRuntime['client'] }) => ReactElement | null;

export function HudChrome({
  rt,
  devPanels,
  hudWidgets,
  overlays,
}: {
  rt: HudRuntime;
  devPanels: Record<string, DevPanel>;
  hudWidgets: Record<string, Widget>;
  overlays: Record<string, Widget>;
}) {
  return (
    <>
      {Object.entries(overlays).map(([id, Layer]) => (
        <Layer key={id} client={rt.client} />
      ))}
      <Banners rt={rt} />
      <PlayerFrame rt={rt} />
      <TargetFrame rt={rt} />
      <Minimap rt={rt} />
      <div className="right-stack">
        {Object.entries(hudWidgets).map(([id, Widget]) => (
          <Widget key={id} client={rt.client} />
        ))}
      </div>
      <MessageLog rt={rt} />
      <PromptLine rt={rt} />
      <ActionBar rt={rt} />
      <HoverTip rt={rt} />
      <DebugDrawer rt={rt} devPanels={devPanels} />
      <FeatureBanner rt={rt} />
      <ConnectionOverlay rt={rt} />
    </>
  );
}
