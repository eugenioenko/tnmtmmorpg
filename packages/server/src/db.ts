import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Entity } from './world.ts';

export interface EntityRow {
  id: number;
  kind: string;
  chunk: string;
  data: string;
  rev: number;
}

export interface TileRow {
  chunk: string;
  data: Uint8Array;
}

export interface PlayerRow {
  id: string;
  name: string;
  entityId: number | null;
  token: string;
}

/**
 * Components (and position) live inside the `data` JSON blob — there are no
 * per-component columns, and there will never be a migration. The moment
 * contributing requires a migration, contributions stop.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  chunk TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}',
  rev INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tiles (
  chunk TEXT PRIMARY KEY,
  data BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  entity_id INTEGER,
  token TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`;

/** Open (creating if needed) a database and make sure the schema exists. */
export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

/**
 * Upsert one entity. `rev` ticks up by one per save; the rest of the row is
 * the entity's live state serialized as JSON in the `data` blob.
 */
export function saveEntity(db: DatabaseSync, entity: Entity): void {
  const prev = db.prepare('SELECT rev FROM entities WHERE id = ?').get(entity.id) as
    | { rev: number }
    | undefined;
  const rev = (prev?.rev ?? 0) + 1;
  const data = JSON.stringify({ x: entity.x, y: entity.y, components: entity.components });
  db.prepare(
    'INSERT OR REPLACE INTO entities (id, kind, chunk, data, rev) VALUES (?, ?, ?, ?, ?)',
  ).run(entity.id, entity.kind, entity.chunk, data, rev);
}

/** Persist one chunk (its raw tile data, one byte per tile). */
export function saveChunk(db: DatabaseSync, chunkKey: string, data: Uint8Array): void {
  db.prepare('INSERT OR REPLACE INTO tiles (chunk, data) VALUES (?, ?)').run(chunkKey, data);
}

/** Every persisted chunk, keyed by its 'cx,cy' chunk key. */
export function loadChunks(db: DatabaseSync): Map<string, Uint8Array> {
  const rows = db
    .prepare('SELECT chunk, data FROM tiles ORDER BY chunk')
    .all() as unknown as TileRow[];
  const chunks = new Map<string, Uint8Array>();
  for (const row of rows) chunks.set(row.chunk, row.data);
  return chunks;
}

export function loadAll(db: DatabaseSync): { entities: EntityRow[] } {
  const entities = db
    .prepare('SELECT id, kind, chunk, data, rev FROM entities ORDER BY id')
    .all() as unknown as EntityRow[];
  return { entities };
}

export function savePlayer(db: DatabaseSync, player: PlayerRow): void {
  db.prepare('INSERT OR REPLACE INTO players (id, name, entity_id, token) VALUES (?, ?, ?, ?)').run(
    player.id,
    player.name,
    player.entityId,
    player.token,
  );
}

/**
 * kv access: without a value, returns the stored value; with a value, stores
 * it and returns the previous value. Undefined means "never set".
 */
export function getSet(db: DatabaseSync, k: string, v?: string): string | undefined {
  const prev = db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined;
  if (v !== undefined) {
    db.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run(k, v);
  }
  return prev?.v;
}
