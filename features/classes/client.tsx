import { useEffect, useReducer, useRef } from 'react';
import { defineClient, isStatsComponent, type ClientAPI } from '@game/shared';
import { CHOOSE_LEVEL, CLASSES, type Ability, type ClassId, type ClassState } from './index.ts';
import './classes.css';

const KEYS = ['KeyQ', 'KeyF', 'KeyG', 'KeyT'];
const KEY_LABELS = ['Q', 'F', 'G', 'T'];

function useLive(client: ClientAPI): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => client.subscribe(force), [client]);
}

function stateOf(client: ClientAPI): ClassState | undefined {
  const s = client.localPlayer()?.components['classes:state'] as ClassState | undefined;
  return s && typeof s.mana === 'number' ? s : undefined;
}

function level(client: ClientAPI): number {
  const s = client.localPlayer()?.components.stats;
  return isStatsComponent(s) ? s.level : 1;
}

function castAbility(client: ClientAPI, ability: Ability): void {
  client.sendIntent({ t: 'intent', kind: 'classes:cast', ability: ability.id, targetId: client.target() ?? undefined });
}

/** Points level-5 players without a path at the choice, and binds Q/F/G/T. */
function ClassAgent({ client }: { client: ClientAPI }) {
  useEffect(() => {
    let claimed: number | null = null;
    let nudged = false;
    return client.subscribe(() => {
      const me = client.localPlayer();
      if (!me) return;
      if (me.id !== claimed) {
        claimed = me.id;
        nudged = false;
        return;
      }
      const s = stateOf(client);
      if (!nudged && s && !s.cls && level(client) >= CHOOSE_LEVEL) {
        nudged = true;
        client.banner('Choose your path', 'Warrior, Ranger or Mystic — press L', 'level');
        client.notify('You are ready to choose a class. Press L.', 'quest');
        client.toggleWindow('classes:path', true);
      }
    });
  }, [client]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target instanceof Element && e.target.closest('input, textarea')) return;
      const slot = KEYS.indexOf(e.code);
      if (slot < 0) return;
      const s = stateOf(client);
      const ability = s?.cls ? CLASSES[s.cls].abilities[slot] : undefined;
      if (!ability) return;
      e.preventDefault();
      castAbility(client, ability);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [client]);
  return null;
}

function AbilityBar({ client }: { client: ClientAPI }) {
  useLive(client);
  const s = stateOf(client);
  if (!s?.cls) return null;
  const def = CLASSES[s.cls];
  const lvl = level(client);
  return (
    <div className="ability-bar frame" onPointerDown={(e) => e.stopPropagation()}>
      {def.abilities.map((a, i) => {
        const locked = lvl < a.level;
        const cd = s.cd[a.id] ?? 0;
        const total = cd > 0 ? a.cooldown : s.gcd > 0 ? 10 : 0;
        const left = cd > 0 ? cd : s.gcd;
        const sweep = total > 0 ? (left / total) * 360 : 0;
        const poor = s.mana < a.cost;
        return (
          <button
            key={a.id}
            type="button"
            className={`ability${locked ? ' locked' : ''}${poor ? ' poor' : ''}${s.casting?.ability === a.id ? ' casting' : ''}`}
            title={`${a.name} — ${a.text}\n${a.cost} ${def.resource}${a.cooldown ? ` · ${(a.cooldown / 10).toFixed(0)}s cooldown` : ''}${a.cast ? ` · ${(a.cast / 10).toFixed(1)}s cast` : ' · instant'}${locked ? `\nUnlocks at level ${a.level}` : ''}`}
            disabled={locked}
            onClick={(e) => {
              e.currentTarget.blur();
              castAbility(client, a);
            }}
          >
            <span className="glyph">{locked ? '🔒' : a.icon}</span>
            {!locked && sweep > 0 && (
              <span className="cooldown" style={{ background: `conic-gradient(rgba(0,0,0,0.72) ${sweep}deg, transparent ${sweep}deg)` }} />
            )}
            {!locked && cd > 0 && <span className="cd-text">{((cd + 9) / 10) | 0}</span>}
            <span className="key">{KEY_LABELS[i]}</span>
            <span className="cost">{locked ? `Lv ${a.level}` : a.cost}</span>
          </button>
        );
      })}
    </div>
  );
}

function ResourceBar({ client }: { client: ClientAPI }) {
  useLive(client);
  const s = stateOf(client);
  if (!s?.cls) return null;
  const def = CLASSES[s.cls];
  const pct = s.maxMana > 0 ? (s.mana / s.maxMana) * 100 : 0;
  return (
    <div className="resource-bar">
      <span className="res-class" style={{ color: def.color }}>
        {def.icon} {def.name}
      </span>
      <div className="res-track">
        <div className="res-fill" style={{ width: `${pct}%`, background: def.color }} />
        <div className="res-label">
          {s.mana} / {s.maxMana} {def.resource}
        </div>
      </div>
    </div>
  );
}

function SpellCast({ client }: { client: ClientAPI }) {
  useLive(client);
  const s = stateOf(client);
  const started = useRef(0);
  if (!s?.casting) return null;
  if (started.current !== s.casting.n) started.current = s.casting.n;
  return (
    <div className="spell-cast">
      <div className="spell-label">{s.casting.label}</div>
      <div className="spell-track">
        <div key={s.casting.n} className="spell-fill" style={{ animationDuration: `${s.casting.ms}ms` }} />
      </div>
    </div>
  );
}

function PathWindow({ client }: { client: ClientAPI }) {
  useLive(client);
  const s = stateOf(client);
  const lvl = level(client);
  return (
    <div className="path-window">
      <div className="hint" style={{ marginBottom: 10 }}>
        {lvl < CHOOSE_LEVEL
          ? `At level ${CHOOSE_LEVEL} you choose a path. You are level ${lvl}.`
          : s?.cls
            ? `You walk the path of the ${CLASSES[s.cls].name}. Changing it costs 50 gold.`
            : 'Choose the path you will walk. You can change it later for a price.'}
      </div>
      <div className="path-cards">
        {(Object.keys(CLASSES) as ClassId[]).map((id) => {
          const def = CLASSES[id];
          const mine = s?.cls === id;
          return (
            <div key={id} className={`path-card${mine ? ' mine' : ''}`} style={{ borderColor: mine ? def.color : undefined }}>
              <div className="path-head">
                <span className="path-icon">{def.icon}</span>
                <span className="path-name" style={{ color: def.color }}>
                  {def.name}
                </span>
              </div>
              <div className="path-blurb">{def.blurb}</div>
              <div className="path-res">Uses {def.resource}</div>
              <ul className="path-abilities">
                {def.abilities.map((a) => (
                  <li key={a.id} className={lvl < a.level ? 'later' : ''}>
                    <span>{a.icon}</span>
                    <span>
                      <b>{a.name}</b> <i>Lv {a.level}</i>
                      <br />
                      {a.text}
                    </span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="btn"
                disabled={lvl < CHOOSE_LEVEL || mine}
                onClick={() => client.sendIntent({ t: 'intent', kind: 'classes:choose', cls: id })}
              >
                {mine ? 'Your path' : s?.cls ? 'Change (50g)' : `Become a ${def.name}`}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default defineClient({
  hud: { 'classes:agent': ClassAgent },
  overlay: {
    'classes:abilities': AbilityBar,
    'classes:resource': ResourceBar,
    'classes:cast': SpellCast,
  },
  windows: {
    'classes:path': { title: 'Your Path', icon: '✦', hotkey: 'KeyL', order: 6, component: PathWindow },
  },
  creation: {
    label: 'Path',
    options: [
      ...Object.values(CLASSES).map((c) => ({ id: c.id, label: c.name, icon: c.icon, blurb: c.blurb })),
      { id: 'undecided', label: 'Undecided', icon: '❔', blurb: `Choose a path later, once you reach level ${CHOOSE_LEVEL}.` },
    ],
  },
});
