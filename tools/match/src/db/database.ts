/**
 * SQLite access via Node's built-in `node:sqlite` — no native build, no external
 * dependency, no licence question (it ships with Node ≥ 22.5). Embeddings are
 * stored as raw little-endian Float32 BLOBs (2 KB for 512-d): compact, exact and
 * trivially reconstituted into a Float32Array for the linear algebra in `ranking/`.
 */
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS photos (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  model         TEXT NOT NULL,
  embedding     BLOB NOT NULL,
  clip_score    REAL,
  aspects       TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comparisons (
  id         INTEGER PRIMARY KEY,
  winner_id  INTEGER NOT NULL REFERENCES photos(id),
  loser_id   INTEGER NOT NULL REFERENCES photos(id),
  session    TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cmp_winner ON comparisons(winner_id);
CREATE INDEX IF NOT EXISTS idx_cmp_loser  ON comparisons(loser_id);
`;

export function openDatabase(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

/** Pack a numeric embedding into a little-endian Float32 BLOB. */
export function encodeEmbedding(values: number[] | Float32Array): Uint8Array {
  const f = values instanceof Float32Array ? values : Float32Array.from(values);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}

/** Unpack a Float32 BLOB into a fresh (aligned, copied) Float32Array. */
export function decodeEmbedding(blob: Uint8Array): Float32Array {
  const copy = Uint8Array.from(blob); // copy → 4-byte alignment and ownership
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}
