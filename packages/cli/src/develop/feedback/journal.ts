/**
 * The feedback journal — every (predicted, kept) observation this machine holds.
 *
 * One `develop feedback` run over one shoot is not a measurement. A per-parameter
 * "kept %" needs tens of images before it says anything, and an amateur's shoot is
 * eight frames: on its own it will never clear that bar, this month or next year.
 *
 * But an observation is per *image* and says nothing about which shoot it came
 * from, so ten shoots of eight carry exactly as much signal as one shoot of
 * eighty — provided somebody keeps them. This is that somebody.
 *
 * What is stored is the raw pair for every compared parameter, never the derived
 * counts. Tolerance, what counts as a slider somebody "moved", how journey is
 * defined: every one of those has already changed once and will change again,
 * and a count recorded under an old definition cannot be reinterpreted under a
 * new one. A pair can, forever.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { Treatment } from '../develop/schema.js';

/** One photograph: what we proposed, and what it says today. */
export interface FeedbackObservation {
  file: string;
  /** When this observation was recorded. */
  at: string;
  /** The prediction record it came from — provenance, and how shoots are counted. */
  run: string;
  treatment: Treatment;
  /** What the profile proposed, per develop parameter. */
  predicted: Record<string, number>;
  /** What the file says now, over exactly the same keys. */
  actual: Record<string, number>;
}

export async function loadJournal(file: string): Promise<FeedbackObservation[]> {
  if (!existsSync(file)) return [];
  const text = await readFile(file, 'utf8');
  const out: FeedbackObservation[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as FeedbackObservation;
      // A line that predates a format change, or a half-written one from a kill
      // mid-write, is skipped rather than allowed to poison the aggregate.
      if (record.file && record.predicted && record.actual) out.push(record);
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * Merge new observations into the journal and return the whole pool.
 *
 * Newest wins per `file`: re-running feedback on a shoot, or developing the same
 * photograph a second time, corrects the old observation rather than voting
 * twice. That makes this a rewrite rather than an append — the file is small
 * (one short line per photograph ever developed) and correctness beats a syscall.
 *
 * Written through a temporary file: the journal is the one develop artifact
 * nothing can rebuild, so it is never left half-written.
 */
export async function recordObservations(
  file: string,
  observations: readonly FeedbackObservation[],
): Promise<FeedbackObservation[]> {
  const merged = new Map<string, FeedbackObservation>();
  for (const existing of await loadJournal(file)) merged.set(existing.file, existing);
  for (const fresh of observations) merged.set(fresh.file, fresh);

  const pool = [...merged.values()];
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, pool.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8');
  await rename(tmp, file);
  return pool;
}

/** Distinct prediction records the pool was collected from. */
export function shootCount(observations: readonly FeedbackObservation[]): number {
  return new Set(observations.map((o) => o.run)).size;
}
