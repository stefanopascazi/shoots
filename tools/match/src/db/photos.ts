/** Photo repository: idempotent upsert on `path`, plus read helpers. */
import { decodeEmbedding, encodeEmbedding, type Db } from './database.js';
import type { PhotoRow } from '../types.js';

export interface PhotoInput {
  path: string;
  model: string;
  embedding: number[];
  clipScore: number | null;
  aspects: unknown;
}

/** Insert or refresh a photo by path (idempotent). */
export function upsertPhoto(db: Db, p: PhotoInput): void {
  db.prepare(
    `INSERT INTO photos (path, model, embedding, clip_score, aspects, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       model = excluded.model,
       embedding = excluded.embedding,
       clip_score = excluded.clip_score,
       aspects = excluded.aspects`,
  ).run(
    p.path,
    p.model,
    encodeEmbedding(p.embedding),
    p.clipScore,
    p.aspects == null ? null : JSON.stringify(p.aspects),
    new Date().toISOString(),
  );
}

interface RawPhotoRow {
  id: number;
  path: string;
  model: string;
  embedding: Uint8Array;
  clip_score: number | null;
  aspects: string | null;
  created_at: string;
}

const hydrate = (r: RawPhotoRow): PhotoRow => ({
  id: Number(r.id),
  path: r.path,
  model: r.model,
  embedding: decodeEmbedding(r.embedding),
  clip_score: r.clip_score == null ? null : Number(r.clip_score),
  aspects: r.aspects,
  created_at: r.created_at,
});

export function allPhotos(db: Db): PhotoRow[] {
  return (db.prepare('SELECT * FROM photos ORDER BY id').all() as unknown as RawPhotoRow[]).map(hydrate);
}

export function getPhoto(db: Db, id: number): PhotoRow | undefined {
  const row = db.prepare('SELECT * FROM photos WHERE id = ?').get(id) as unknown as RawPhotoRow | undefined;
  return row ? hydrate(row) : undefined;
}

export function countPhotos(db: Db): number {
  return Number((db.prepare('SELECT COUNT(*) AS n FROM photos').get() as { n: number }).n);
}

/** Distinct embedding-model names present (guards a mixed-space dataset). */
export function distinctModels(db: Db): string[] {
  return (db.prepare('SELECT DISTINCT model FROM photos').all() as unknown as { model: string }[]).map((r) => r.model);
}
