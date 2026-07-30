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
  /**
   * The base rendering we wrote, and the one the file carries now.
   *
   * The nearest thing to evidence that our sidecar was actually imported: every
   * slider is measured against the rendering underneath it, and a file still
   * carrying the rendering `predict` wrote is a file that read our sidecar. When
   * they differ, the "correction" may be two independent opinions rather than
   * our error — which matters enormously to anything that acts on it.
   *
   * Optional: journals written before this existed are still perfectly good
   * observations, they just cannot answer the question.
   */
  predictedRender?: string;
  actualRender?: string;
  /**
   * This photograph is in the training set, folded in by `develop learn`.
   *
   * Provenance, not a verdict. The pair above is still a perfectly good held-out
   * measurement — the prediction was made *before* the photograph became training
   * data, and folding it in afterwards cannot reach back and contaminate a number
   * already written down. What it does mean is that the *next* prediction for
   * this file will come from a model that has seen its answer; see
   * {@link FeedbackObservation.inSample}.
   */
  trainedOn?: boolean;
  /**
   * The prediction in this record was made by a model already fitted on this
   * photograph — so the gap between them understates the real error.
   *
   * Only reachable by developing the same shoot twice: `edit` it, `learn` from
   * it, then `edit` and `feedback` it again. Rare, but it is the one case where
   * an observation genuinely cannot measure anything, and it is worth one boolean
   * to keep it out of the calibration rather than to ban a whole workflow.
   */
  inSample?: boolean;
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
  for (const fresh of observations) {
    // `trainedOn` is a fact about the photograph, not about this measurement of
    // it, so a newer observation inherits it rather than quietly clearing it.
    const wasTrainedOn = merged.get(fresh.file)?.trainedOn;
    merged.set(fresh.file, wasTrainedOn ? { ...fresh, trainedOn: true } : fresh);
  }

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

/**
 * Mark photographs as consumed by training.
 *
 * Called by `develop learn` once the files are in the dataset. Rewrites in place
 * and silently does nothing when the journal is missing — a photographer who
 * never ran `feedback` still gets to run `learn`.
 */
export async function markTrainedOn(file: string, files: readonly string[]): Promise<number> {
  if (!existsSync(file)) return 0;
  const wanted = new Set(files);
  const pool = await loadJournal(file);
  let marked = 0;
  const updated = pool.map((o) => {
    if (!wanted.has(o.file) || o.trainedOn) return o;
    marked++;
    return { ...o, trainedOn: true };
  });
  if (marked === 0) return 0;
  const tmp = `${file}.tmp`;
  await writeFile(tmp, updated.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8');
  await rename(tmp, file);
  return marked;
}
