import { useEffect, useReducer, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { defineClient, type ClientAPI, type EntityState } from '@game/shared';
import type { ChatLine } from './index.ts';
import './chat.css';

type Channel = 'say' | 'yell' | 'world' | 'party' | 'guild';

const CHANNELS: Record<Channel, { label: string; prefix: string }> = {
  say: { label: 'Say', prefix: '' },
  yell: { label: 'Yell', prefix: '/y ' },
  world: { label: 'World', prefix: '/g ' },
  party: { label: 'Party', prefix: '/p ' },
  guild: { label: 'Guild', prefix: '/gc ' },
};

const STICKY: Record<string, Channel> = { s: 'say', say: 'say', y: 'yell', yell: 'yell', g: 'world', world: 'world', p: 'party', gc: 'guild' };

interface Inbox {
  seq: number;
  lines: ChatLine[];
}

interface Bubble {
  n: number;
  text: string;
  emote: boolean;
}

function inboxOf(e: EntityState | undefined): Inbox | undefined {
  const box = e?.components['chat:inbox'] as Inbox | undefined;
  return box && Array.isArray(box.lines) && typeof box.seq === 'number' ? box : undefined;
}

function show(client: ClientAPI, line: ChatLine): void {
  switch (line.ch) {
    case 'say':
      return client.notify(line.text, 'chat', `${line.from}:`);
    case 'yell':
      return client.notify(line.text, 'chat', `${line.from} yells:`);
    case 'world':
      return client.notify(line.text, 'world', `[World] ${line.from}:`);
    case 'party':
      return line.from
        ? client.notify(line.text, 'party', `[Party] ${line.from}:`)
        : client.notify(line.text, 'party');
    case 'guild':
      return line.from
        ? client.notify(line.text, 'guild', `[Guild] ${line.from}:`)
        : client.notify(line.text, 'guild');
    case 'whisper-in':
      return client.notify(line.text, 'whisper', `${line.from} whispers:`);
    case 'whisper-out':
      return client.notify(line.text, 'whisper', `To ${line.from}:`);
    case 'emote':
      return client.notify(line.text, 'emote');
    default:
      return client.notify(line.text, 'info');
  }
}

/** Shows each inbox line once, starting from whatever was there on connect. */
function useInboxRelay(client: ClientAPI): void {
  useEffect(() => {
    let owner: number | null = null;
    let seen = 0;
    return client.subscribe(() => {
      const me = client.localPlayer();
      if (!me) return;
      const box = inboxOf(me);
      if (me.id !== owner) {
        owner = me.id;
        seen = box?.seq ?? 0;
        return;
      }
      if (!box || box.seq <= seen) return;
      for (const line of box.lines) if (line.n > seen) show(client, line);
      seen = box.seq;
    });
  }, [client]);
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('input, textarea') !== null;
}

function ChatBar({ client }: { client: ClientAPI }) {
  useInboxRelay(client);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [channel, setChannel] = useState<Channel>('say');
  const history = useRef<string[]>([]);
  const cursor = useRef(-1);

  const openWith = (value: string): void => {
    cursor.current = -1;
    flushSync(() => {
      setText(value);
      setOpen(true);
    });
    const el = input.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(value.length, value.length);
  };

  const close = (): void => {
    setOpen(false);
    setText('');
    input.current?.blur();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTyping(e.target) || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.preventDefault();
        openWith('');
      } else if (e.key === '/') {
        e.preventDefault();
        openWith('/');
      } else if (e.code === 'KeyR' && !e.shiftKey) {
        e.preventDefault();
        openWith('/r ');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const send = (): void => {
    const raw = text.trim();
    if (!raw) {
      close();
      return;
    }
    history.current = [raw, ...history.current.filter((h) => h !== raw)].slice(0, 30);
    const sticky = /^\/(\w+)\s/.exec(raw)?.[1]?.toLowerCase();
    if (sticky && STICKY[sticky]) setChannel(STICKY[sticky]);
    const message = raw.startsWith('/') ? raw : CHANNELS[channel].prefix + raw;
    client.sendIntent({ t: 'intent', kind: 'chat:send', text: message });
    close();
  };

  const cycle = (): void => {
    const order: Channel[] = ['say', 'yell', 'world', 'party', 'guild'];
    setChannel(order[(order.indexOf(channel) + 1) % order.length]);
    if (open) input.current?.focus();
  };

  return (
    <div
      className={`chat-bar${open ? ' open' : ''} ch-${channel}`}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (!open) openWith('');
      }}
    >
      <button
        type="button"
        className="chat-channel"
        title="Channel (click to change)"
        onPointerDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          cycle();
        }}
      >
        {CHANNELS[channel].label}
      </button>
      {open ? (
        <input
          ref={input}
          className="chat-input"
          value={text}
          maxLength={180}
          spellCheck={false}
          autoComplete="off"
          placeholder="Say something, or /help"
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            if (!text.trim()) setOpen(false);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              send();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              close();
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const list = history.current;
              const next = cursor.current + (e.key === 'ArrowUp' ? 1 : -1);
              if (next < -1 || next >= list.length) return;
              cursor.current = next;
              setText(next === -1 ? '' : list[next]);
            }
          }}
        />
      ) : (
        <span className="chat-hint">
          Press <kbd>Enter</kbd> to chat · <kbd>/</kbd> commands · <kbd>R</kbd> reply
        </span>
      )}
    </div>
  );
}

/** Speech bubbles over whoever is talking; positioned every frame, rebuilt per snapshot. */
function Bubbles({ client }: { client: ClientAPI }) {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => client.subscribe(force), [client]);
  const nodes = useRef(new Map<number, HTMLDivElement>());

  const position = (id: number, el: HTMLDivElement): void => {
    const p = client.screenOf(id);
    if (!p) {
      el.style.visibility = 'hidden';
      return;
    }
    el.style.visibility = 'visible';
    el.style.transform = `translate(${p.x | 0}px, ${(p.y | 0) - 22}px) translate(-50%, -100%)`;
  };

  useEffect(() => {
    let frame = 0;
    const place = (): void => {
      for (const [id, el] of nodes.current) position(id, el);
      frame = requestAnimationFrame(place);
    };
    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [client]);

  const speaking: { id: number; bubble: Bubble }[] = [];
  for (const e of client.entities()) {
    const b = e.components['chat:bubble'] as Bubble | undefined;
    if (b && typeof b.text === 'string') speaking.push({ id: e.id, bubble: b });
  }

  return (
    <div className="chat-bubbles">
      {speaking.map(({ id, bubble }) => (
        <div
          key={id}
          ref={(el) => {
            if (el) {
              nodes.current.set(id, el);
              position(id, el);
            } else nodes.current.delete(id);
          }}
          className="chat-bubble-anchor"
        >
          <div key={bubble.n} className={`chat-bubble${bubble.emote ? ' emote' : ''}`}>
            {bubble.text}
          </div>
        </div>
      ))}
    </div>
  );
}

export default defineClient({
  overlay: {
    'chat:bubbles': Bubbles,
    'chat:bar': ChatBar,
  },
});
