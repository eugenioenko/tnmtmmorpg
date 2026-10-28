import { useEffect, useReducer, useRef } from 'react';
import { defineClient, type ClientAPI, type EntityState } from '@game/shared';
import { MAX_SIZE, type PartyTag, type Roster, type RosterMember } from './index.ts';
import './party.css';

function useLive(client: ClientAPI): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => client.subscribe(force), [client]);
}

function rosterOf(client: ClientAPI): Roster {
  const raw = client.localPlayer()?.components['party:roster'];
  return typeof raw === 'object' && raw !== null ? (raw as Roster) : {};
}

function tagOf(e: EntityState | undefined): number | undefined {
  const t = e?.components['party:tag'] as PartyTag | undefined;
  return typeof t?.id === 'number' ? t.id : undefined;
}

function nameOf(e: EntityState): string {
  const c = e.components.character as { name?: unknown } | undefined;
  return typeof c?.name === 'string' ? c.name : `Wanderer ${e.id}`;
}

const send = (client: ClientAPI, kind: string, extra: Record<string, unknown> = {}): void =>
  client.sendIntent({ t: 'intent', kind, ...extra });

const ARROWS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
const abs = (n: number): number => (n < 0 ? -n : n);
const cheb = (ax: number, ay: number, bx: number, by: number): number =>
  abs(ax - bx) > abs(ay - by) ? abs(ax - bx) : abs(ay - by);

/** Compass octant 0..7 (0 = east, clockwise, y grows downward). */
function octant(dx: number, dy: number): number {
  const ax = abs(dx);
  const ay = abs(dy);
  if (ay * 5 < ax * 2) return dx > 0 ? 0 : 4;
  if (ax * 5 < ay * 2) return dy > 0 ? 2 : 6;
  if (dx > 0) return dy > 0 ? 1 : 7;
  return dy > 0 ? 3 : 5;
}

/** "here", "12 ↗", or which world they are in. */
function whereabouts(me: EntityState | undefined, m: RosterMember): string {
  if (!m.online) return 'away';
  if (!me || m.x === undefined || m.y === undefined) return '';
  if ((m.world ?? 'overworld') !== (me.world ?? 'overworld')) {
    const w = m.world ?? '';
    return w.startsWith('dungeon:') ? 'in a cave' : w.startsWith('interior:') ? 'indoors' : 'elsewhere';
  }
  const dist = cheb(m.x, m.y, me.x, me.y);
  if (dist <= 3) return 'here';
  return `${dist} ${ARROWS[octant(m.x - me.x, m.y - me.y)]}`;
}

function MemberRow({ client, m, leader, mine, canKick }: { client: ClientAPI; m: RosterMember; leader: boolean; mine: boolean; canKick: boolean }) {
  const raw = m.hp !== undefined && m.maxHp ? (m.hp / m.maxHp) * 100 : 0;
  const pct = raw < 0 ? 0 : raw > 100 ? 100 : raw;
  return (
    <div className={`party-member${m.online ? '' : ' away'}${mine ? ' me' : ''}`}>
      <div className="party-member-top">
        {leader && <span className="party-crown" title="Party leader">👑</span>}
        <span className="party-name">{m.name}</span>
        {m.level !== undefined && <span className="party-level">{m.level}</span>}
        <span className="party-where">{mine ? '' : whereabouts(client.localPlayer(), m)}</span>
        {canKick && !mine && (
          <button type="button" className="party-x" title={`Remove ${m.name}`} onClick={() => send(client, 'party:kick', { name: m.name })}>
            ×
          </button>
        )}
      </div>
      <div className="bar hp party-hp">
        <div className="fill" style={{ width: `${m.online ? pct : 0}%` }} />
      </div>
    </div>
  );
}

/** Left-hand party frames, under the player's own frame. */
function PartyFrames({ client }: { client: ClientAPI }) {
  useLive(client);
  const { party } = rosterOf(client);
  const me = client.localPlayer();
  if (!party || !me) return null;
  const myName = nameOf(me);
  const iLead = party.leader.toLowerCase() === myName.toLowerCase();
  return (
    <div className="party-frames frame" onPointerDown={(e) => e.stopPropagation()}>
      <div className="party-head">
        <span>Party</span>
        <span className="muted">
          {party.members.length}/{MAX_SIZE}
        </span>
        <span className="spacer" />
        <button type="button" className="btn small" onClick={() => send(client, 'party:leave')}>
          Leave
        </button>
      </div>
      {party.members.map((m) => (
        <MemberRow
          key={m.name}
          client={client}
          m={m}
          leader={m.name === party.leader}
          mine={m.name.toLowerCase() === myName.toLowerCase()}
          canKick={iLead}
        />
      ))}
    </div>
  );
}

function InvitePrompt({ client }: { client: ClientAPI }) {
  useLive(client);
  const { invite, outgoing } = rosterOf(client);
  if (invite) {
    return (
      <div className="party-invite frame" onPointerDown={(e) => e.stopPropagation()}>
        <div>
          <b>{invite.from}</b> invites you to their party.
        </div>
        <div className="party-actions">
          <button type="button" className="btn accept" onClick={() => send(client, 'party:respond', { accept: true })}>
            Join
          </button>
          <button type="button" className="btn" onClick={() => send(client, 'party:respond', { accept: false })}>
            Decline
          </button>
        </div>
      </div>
    );
  }
  if (outgoing) {
    return (
      <div className="party-invite frame small" onPointerDown={(e) => e.stopPropagation()}>
        Waiting for <b>{outgoing.to}</b> to answer…
      </div>
    );
  }
  return null;
}

/** A small blue diamond over every fellow party member in view. */
function Markers({ client }: { client: ClientAPI }) {
  useLive(client);
  const nodes = useRef(new Map<number, HTMLDivElement>());
  useEffect(() => {
    let frame = 0;
    const place = (): void => {
      for (const [id, el] of nodes.current) {
        const p = client.screenOf(id);
        el.style.visibility = p ? 'visible' : 'hidden';
        if (p) el.style.transform = `translate(${p.x | 0}px, ${(p.y | 0) - 30}px) translate(-50%, -100%)`;
      }
      frame = requestAnimationFrame(place);
    };
    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [client]);

  const me = client.localPlayer();
  const mine = tagOf(me);
  const mates: number[] = [];
  if (mine !== undefined) {
    for (const e of client.entities()) if (e.id !== me?.id && e.kind === 'player' && tagOf(e) === mine) mates.push(e.id);
  }
  return (
    <div className="party-markers">
      {mates.map((id) => (
        <div
          key={id}
          className="party-marker"
          ref={(el) => {
            if (el) nodes.current.set(id, el);
            else nodes.current.delete(id);
          }}
        >
          ◆
        </div>
      ))}
    </div>
  );
}

function PartyWindow({ client }: { client: ClientAPI }) {
  useLive(client);
  const me = client.localPlayer();
  const { party, outgoing } = rosterOf(client);
  if (!me) return null;
  const myName = nameOf(me);
  const iLead = !party || party.leader.toLowerCase() === myName.toLowerCase();
  const full = party !== undefined && party.members.length >= MAX_SIZE;
  const mine = tagOf(me);
  const nearby = [...client.entities()]
    .filter((e) => e.kind === 'player' && e.id !== me.id && (e.world ?? 'overworld') === (me.world ?? 'overworld'))
    .map((e) => ({ e, d: cheb(e.x, e.y, me.x, me.y) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 8);

  return (
    <div className="party-window">
      {party ? (
        <>
          <div className="section-title">
            Your party ({party.members.length}/{MAX_SIZE})
          </div>
          {party.members.map((m) => (
            <div key={m.name} className="party-line">
              <span>{m.name === party.leader ? '👑 ' : ''}{m.name}</span>
              <span className="muted">{m.name.toLowerCase() === myName.toLowerCase() ? 'you' : whereabouts(me, m)}</span>
              {iLead && m.name.toLowerCase() !== myName.toLowerCase() && (
                <>
                  <button type="button" className="btn small" onClick={() => send(client, 'party:promote', { name: m.name })}>
                    Lead
                  </button>
                  <button type="button" className="btn small danger" onClick={() => send(client, 'party:kick', { name: m.name })}>
                    Remove
                  </button>
                </>
              )}
            </div>
          ))}
          <button type="button" className="btn small party-leave" onClick={() => send(client, 'party:leave')}>
            Leave party
          </button>
        </>
      ) : (
        <p className="muted">You travel alone. Invite someone nearby, or type /invite Name in chat.</p>
      )}

      <div className="section-title">Nearby</div>
      {nearby.length === 0 && <p className="muted">Nobody in sight.</p>}
      {nearby.map(({ e, d }) => {
        const same = mine !== undefined && tagOf(e) === mine;
        const taken = !same && tagOf(e) !== undefined;
        return (
          <div key={e.id} className="party-line">
            <span>{nameOf(e)}</span>
            <span className="muted">{d} tiles</span>
            {same ? (
              <span className="muted">in your party</span>
            ) : taken ? (
              <span className="muted">in a party</span>
            ) : (
              <button
                type="button"
                className="btn small"
                disabled={!iLead || full || outgoing !== undefined}
                onClick={() => send(client, 'party:invite', { targetId: e.id })}
              >
                Invite
              </button>
            )}
          </div>
        );
      })}
      <p className="muted party-tip">
        Party members within 30 tiles share experience and quest kills, and follow each other into caves. /p talks to the
        party.
      </p>
    </div>
  );
}

export default defineClient({
  overlay: {
    'party:frames': PartyFrames,
    'party:invite': InvitePrompt,
    'party:markers': Markers,
  },
  windows: {
    'party:window': { title: 'Party', icon: '🤝', hotkey: 'KeyO', order: 40, component: PartyWindow },
  },
});
