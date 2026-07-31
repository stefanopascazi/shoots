/** Comparison repository: record duel outcomes and read them back. */
import type { Db } from './database.js';
import type { Comparison } from '../types.js';

export function recordComparison(db: Db, winnerId: number, loserId: number, session: string | null): void {
  db.prepare(
    'INSERT INTO comparisons (winner_id, loser_id, session, created_at) VALUES (?, ?, ?, ?)',
  ).run(winnerId, loserId, session, new Date().toISOString());
}

export function allComparisons(db: Db): Comparison[] {
  return (db.prepare('SELECT winner_id, loser_id FROM comparisons').all() as unknown as Comparison[]).map((c) => ({
    winner_id: Number(c.winner_id),
    loser_id: Number(c.loser_id),
  }));
}

export function countComparisons(db: Db): number {
  return Number((db.prepare('SELECT COUNT(*) AS n FROM comparisons').get() as { n: number }).n);
}

/** How many comparisons each photo has taken part in (id → count). */
export function comparisonCounts(db: Db): Map<number, number> {
  const rows = db
    .prepare(
      `SELECT id, (
         SELECT COUNT(*) FROM comparisons c
         WHERE c.winner_id = photos.id OR c.loser_id = photos.id
       ) AS n
       FROM photos`,
    )
    .all() as unknown as { id: number; n: number }[];
  return new Map(rows.map((r) => [Number(r.id), Number(r.n)]));
}
