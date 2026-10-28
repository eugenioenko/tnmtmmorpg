import { useEffect, useReducer, useRef, useState, type KeyboardEvent } from 'react';
import { defineClient, type ClientAPI, type EntityState } from '@game/shared';
import { cleanGuildName, cleanTag, FOUND_COST, MAX_MEMBERS, MAX_MOTD, type GuildTag, type Rank, type Roster, type RosterMember } from './index.ts';
import './guilds.css';

function useLive(client: ClientAPI): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => client.subscribe(force), [client]);
}

function rosterOf(client: ClientAPI): Roster {
  const raw = client.localPlayer()?.components['guilds:roster'];
  return typeof raw === 'object' && raw !== null ? (raw as Roster) : {};
}

function tagOf(e: EntityState | undefined): GuildTag | undefined {
  const t = e?.components['guilds:tag'] as GuildTag | undefined;
  return typeof t?.tag === 'string' ? t : undefined;
}

function goldOf(e: EntityState | undefined): number {
  const c = e?.components.character as { gold?: unknown } | undefined;
  return typeof c?.gold === 'number' ? c.gold : 0;
}

const send = (client: ClientAPI, kind: string, extra: Record<string, unknown> = {}): void =>
  client.sendIntent({ t: 'intent', kind, ...extra });

const stop = (e: KeyboardEvent<HTMLInputElement>): void => {
  e.stopPropagation();
  if (e.key === 'Enter') e.currentTarget.blur();
};

const RANK_LABEL: Record<Rank, string> = { leader: 'Leader', officer: 'Officer', member: 'Member' };

function seen(m: RosterMember): string {
  if (m.online) return 'online';
  if (!m.seen) return 'away';
  const h = ((Date.now() - m.seen) / 3_600_000) | 0;
  if (h < 1) return 'within the hour';
  if (h < 48) return `${h} h ago`;
  return `${(h / 24) | 0} days ago`;
}

function FoundForm({ client }: { client: ClientAPI }) {
  const [name, setName] = useState('');
  const [tag, setTag] = useState('');
  const gold = goldOf(client.localPlayer());
  const n = cleanGuildName(name);
  const t = cleanTag(tag);
  const ok = n.length >= 3 && t.length >= 2 && gold >= FOUND_COST;
  return (
    <div className="guild-found">
      <div className="muted">Band together under a name and a tag that every member wears. Founding costs {FOUND_COST} gold.</div>
      <label>
        Name
        <input value={name} maxLength={24} placeholder="The Lantern Bearers" onKeyDown={stop} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Tag
        <input className="guild-tag-input" value={tag} maxLength={4} placeholder="LAMP" onKeyDown={stop} onChange={(e) => setTag(cleanTag(e.target.value))} />
      </label>
      <div className="guild-found-foot">
        {t && <span className="guild-tag-preview">&lt;{t}&gt;</span>}
        <button type="button" className="btn" disabled={!ok} title={gold < FOUND_COST ? `You carry ${gold} gold` : undefined} onClick={() => send(client, 'guilds:found', { name: n, tag: t })}>
          Found guild · {FOUND_COST}g
        </button>
      </div>
    </div>
  );
}

function GuildWindow({ client }: { client: ClientAPI }) {
  useLive(client);
  const roster = rosterOf(client);
  const [invite, setInvite] = useState('');
  const [motd, setMotd] = useState<string | null>(null);
  const [sure, setSure] = useState(false);
  const g = roster.guild;
  if (!g) {
    return (
      <div className="guilds">
        {roster.invite && <InviteBox client={client} invite={roster.invite} />}
        <FoundForm client={client} />
      </div>
    );
  }
  const lead = g.me === 'leader';
  const officer = g.me !== 'member';
  const on = g.members.filter((m) => m.online).length;
  const myName = (client.localPlayer()?.components.character as { name?: string } | undefined)?.name;
  return (
    <div className="guilds">
      <div className="guild-title">
        <span className="guild-tag-chip">&lt;{g.tag}&gt;</span>
        <span className="guild-name">{g.name}</span>
        <span className="muted guild-count">
          {on} online · {g.members.length}/{MAX_MEMBERS}
        </span>
      </div>
      {officer ? (
        <input
          className="guild-motd edit"
          maxLength={MAX_MOTD}
          placeholder="Set a message of the day…"
          value={motd ?? g.motd}
          onKeyDown={stop}
          onChange={(e) => setMotd(e.target.value)}
          onBlur={() => {
            if (motd !== null && motd !== g.motd) send(client, 'guilds:motd', { text: motd });
            setMotd(null);
          }}
        />
      ) : (
        <div className="guild-motd">{g.motd || <span className="muted">No message of the day.</span>}</div>
      )}
      <div className="guild-members">
        {g.members.map((m) => {
          const self = m.name === myName;
          const canKick = !self && (lead ? m.rank !== 'leader' : g.me === 'officer' && m.rank === 'member');
          return (
            <div key={m.name} className={`guild-member${m.online ? '' : ' away'}`}>
              <span className={`guild-rank ${m.rank}`}>{m.rank === 'leader' ? '👑' : m.rank === 'officer' ? '★' : '·'}</span>
              <span className="guild-member-name">{m.name}</span>
              {m.level !== undefined && <span className="guild-level">{m.level}</span>}
              <span className="guild-seen muted">{seen(m)}</span>
              {lead && m.rank !== 'leader' && (
                <button type="button" className="btn small" title={m.rank === 'officer' ? `Make ${m.name} leader (you become an officer)` : `Make ${m.name} an officer`} onClick={() => send(client, 'guilds:promote', { name: m.name })}>
                  {m.rank === 'officer' ? 'Make leader' : 'Promote'}
                </button>
              )}
              {lead && m.rank === 'officer' && (
                <button type="button" className="btn small" onClick={() => send(client, 'guilds:demote', { name: m.name })}>
                  Demote
                </button>
              )}
              {canKick && (
                <button type="button" className="btn small danger" title={`Remove ${m.name}`} onClick={() => send(client, 'guilds:kick', { name: m.name })}>
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>
      {officer && (
        <div className="guild-invite">
          <input value={invite} placeholder="Character name" onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && invite.trim()) {
              send(client, 'guilds:invite', { name: invite.trim() });
              setInvite('');
            }
          }} onChange={(e) => setInvite(e.target.value)} />
          <button type="button" className="btn small" disabled={!invite.trim()} onClick={() => { send(client, 'guilds:invite', { name: invite.trim() }); setInvite(''); }}>
            Invite
          </button>
        </div>
      )}
      <div className="guild-foot">
        <span className="muted">You are {RANK_LABEL[g.me].toLowerCase()} · /gc to talk</span>
        {lead && g.members.length === 1 ? (
          <button type="button" className="btn small danger" onClick={() => (sure ? send(client, 'guilds:disband') : setSure(true))}>
            {sure ? 'Really disband?' : 'Disband'}
          </button>
        ) : (
          <button type="button" className="btn small danger" title={lead ? 'The senior officer takes over' : undefined} onClick={() => (sure ? send(client, 'guilds:leave') : setSure(true))}>
            {sure ? 'Really leave?' : 'Leave guild'}
          </button>
        )}
      </div>
    </div>
  );
}

function InviteBox({ client, invite }: { client: ClientAPI; invite: NonNullable<Roster['invite']> }) {
  return (
    <div className="guild-invite-box">
      <div>
        <b>{invite.from}</b> invites you to join <span className="guild-tag-chip">&lt;{invite.tag}&gt;</span> <b>{invite.name}</b>
      </div>
      <div className="guild-actions">
        <button type="button" className="btn small" onClick={() => send(client, 'guilds:respond', { accept: true })}>
          Join
        </button>
        <button type="button" className="btn small danger" onClick={() => send(client, 'guilds:respond', { accept: false })}>
          Decline
        </button>
      </div>
    </div>
  );
}

function InvitePrompt({ client }: { client: ClientAPI }) {
  useLive(client);
  const invite = rosterOf(client).invite;
  if (!invite) return null;
  return (
    <div className="guild-invite-prompt frame">
      <InviteBox client={client} invite={invite} />
    </div>
  );
}

/** <TAG> over every guild member's head. */
function Tags({ client }: { client: ClientAPI }) {
  useLive(client);
  const nodes = useRef(new Map<number, HTMLDivElement>());
  useEffect(() => {
    let frame = 0;
    const place = (): void => {
      for (const [id, el] of nodes.current) {
        const p = client.screenOf(id);
        el.style.visibility = p ? 'visible' : 'hidden';
        if (p) el.style.transform = `translate(${p.x | 0}px, ${(p.y | 0) + 2}px) translate(-50%, -100%)`;
      }
      frame = requestAnimationFrame(place);
    };
    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [client]);
  const mine = tagOf(client.localPlayer())?.tag;
  const tagged: { id: number; tag: string; name: string }[] = [];
  for (const e of client.entities()) {
    const t = e.kind === 'player' ? tagOf(e) : undefined;
    if (t) tagged.push({ id: e.id, tag: t.tag, name: t.name });
  }
  return (
    <div className="guild-tags">
      {tagged.map((t) => (
        <div
          key={t.id}
          className={`guild-tag${t.tag === mine ? ' mine' : ''}`}
          title={t.name}
          ref={(el) => {
            if (el) nodes.current.set(t.id, el);
            else nodes.current.delete(t.id);
          }}
        >
          &lt;{t.tag}&gt;
        </div>
      ))}
    </div>
  );
}

export default defineClient({
  windows: {
    'guilds:guild': { title: 'Guild', icon: '🛡', hotkey: 'KeyU', component: GuildWindow, order: 55 },
  },
  overlay: { 'guilds:tags': Tags, 'guilds:invite': InvitePrompt },
});
