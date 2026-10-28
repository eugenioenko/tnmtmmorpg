import type { AccountMessage, CharacterRequest, CharacterSummary, DeniedMessage } from '@game/shared';

/**
 * - connecting: no answer from the server yet
 * - select:     signed in, choosing or creating a character
 * - playing:    a character is in the world
 * - denied:     the server turned the session away; no reconnecting
 */
export type Phase = 'connecting' | 'select' | 'playing' | 'denied';

type Listener = () => void;

/** Who is signed in and which character they play; the account screen renders from this. */
export class Account {
  phase: Phase = 'connecting';
  characters: CharacterSummary[] = [];
  maxCharacters = 0;
  error: string | undefined;
  denied: DeniedMessage | undefined;
  /** Re-entered automatically after a dropped connection. */
  playing: string | undefined;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly send: (request: CharacterRequest) => void) {}

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  /** The server's roster. Returns the character to re-enter after a reconnect, if any. */
  roster(msg: AccountMessage): string | undefined {
    this.characters = msg.characters;
    this.maxCharacters = msg.maxCharacters;
    this.error = msg.error;
    const resume = this.phase === 'connecting' ? this.playing : undefined;
    if (resume && this.characters.some((c) => c.id === resume)) return resume;
    this.playing = undefined;
    this.phase = 'select';
    this.changed();
    return undefined;
  }

  entered(): void {
    this.phase = 'playing';
    this.error = undefined;
    this.changed();
  }

  disconnected(): void {
    if (this.phase === 'denied') return;
    this.phase = 'connecting';
    this.changed();
  }

  deny(msg: DeniedMessage): void {
    this.phase = 'denied';
    this.denied = msg;
    this.playing = undefined;
    this.changed();
  }

  create(name: string, traits: Record<string, string>): void {
    this.send({ t: 'char:create', name, traits });
  }

  remove(id: string): void {
    this.send({ t: 'char:delete', id });
  }

  play(id: string): void {
    this.playing = id;
    this.send({ t: 'char:play', id });
  }

  leave(): void {
    this.playing = undefined;
    this.send({ t: 'char:leave' });
  }
}
