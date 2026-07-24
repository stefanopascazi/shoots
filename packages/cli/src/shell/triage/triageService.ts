/**
 * Interactive-cull orchestration, in-process (the batch `shoots cull` stays
 * non-interactive). Analyses a folder, auto-relocates the confident rejects to
 * --dest (mirroring the source structure), leaves the keepers in place, and
 * hands back the uncertain frames (the focus-peak "rescued" shots) for the
 * shell to review one by one.
 *
 * Keepers are never touched. Rejects (auto-blurry + review "discard") move to
 * --dest by default; `copy` leaves the originals in place. Nothing is deleted.
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import { JobQueue, scanFiles } from '@shoots/core';
import { analyzeBlur, readMetadata, type FocusMap } from '@shoots/imaging';
import { relocate } from '../../relocate.js';

export interface ReviewItem {
  file: string;
  name: string;
  score: number;
  focusPeak: number;
  aperture: number | null;
  focusMap: FocusMap;
}

export type ReviewDecision = 'keep' | 'discard';

export interface TriageResult {
  dest: string;
  /** Scan root the rejects mirror under (needed to relocate review decisions). */
  root: string;
  /** Move rejects (default) or copy them. */
  move: boolean;
  /** Whether this was a dry run (nothing relocated; counts are what *would* happen). */
  dryRun: boolean;
  /** Confident keepers left in place. */
  autoSharp: number;
  /** Confident rejects relocated to --dest (or that would be, in a dry run). */
  autoBlurry: number;
  /** Uncertain (rescued) frames awaiting a decision. */
  review: ReviewItem[];
  failed: { file: string; error: string }[];
  total: number;
}

export interface TriageOptions {
  /** Reject destination (required). Rejects mirror the source structure under it. */
  dest: string;
  threshold?: number;
  focusThreshold?: number;
  concurrency?: number;
  /** Copy rejects instead of moving them. */
  copy?: boolean;
  /** Analyse and queue for review, but relocate nothing. */
  dryRun?: boolean;
  onProgress?: (done: number, total: number) => void;
}

const normalizePath = (p: string): string => p.replace(/\\/g, '/');

/** Analyse a folder, auto-relocate the confident rejects, queue the rest. */
export async function runTriage(targetPath: string, options: TriageOptions): Promise<TriageResult> {
  const dryRun = options.dryRun ?? false;
  const move = !options.copy;
  const dest = path.resolve(options.dest);
  // Root the mirror at the scanned folder; a single-file target mirrors by basename.
  const root = statSync(targetPath).isDirectory()
    ? path.resolve(targetPath)
    : path.dirname(path.resolve(targetPath));
  // Never re-scan our own output if --dest sits inside the target.
  const destPrefix = dest + path.sep;
  const files = (await scanFiles(targetPath)).filter(
    (f) => f.path !== dest && !f.path.startsWith(destPrefix),
  );
  const total = files.length;

  const queue = new JobQueue({ concurrency: options.concurrency ?? 4 });
  let done = 0;
  const outcomes = await queue.run(
    files,
    (file) =>
      analyzeBlur(file.path, {
        threshold: options.threshold,
        focusThreshold: options.focusThreshold,
      }),
    () => options.onProgress?.(++done, total),
    (file) => file.name,
  );

  // Best-effort aperture for the review cards.
  const apertureByFile = new Map<string, number>();
  try {
    const records = await readMetadata(files.map((f) => f.path), { tags: ['FNumber'] });
    for (const rec of records) {
      const raw = rec.FNumber;
      const f = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''));
      if (Number.isFinite(f)) apertureByFile.set(normalizePath(rec.SourceFile), f);
    }
  } catch {
    // aperture is optional context; ignore when exiftool is unavailable
  }

  const review: ReviewItem[] = [];
  const failed: { file: string; error: string }[] = [];
  let autoSharp = 0;
  let autoBlurry = 0;

  for (const o of outcomes) {
    if (!o.ok || !o.value) {
      failed.push({ file: o.item.path, error: o.error?.message ?? 'unknown error' });
      continue;
    }
    const r = o.value;
    if (r.rescued) {
      review.push({
        file: r.file,
        name: path.basename(r.file),
        score: r.score,
        focusPeak: r.focusPeak,
        aperture: apertureByFile.get(normalizePath(r.file)) ?? null,
        focusMap: r.focusMap,
      });
    } else if (r.verdict === 'sharp') {
      autoSharp++; // keeper — left exactly where it is
    } else {
      if (!dryRun) await relocate(root, r.file, dest, { move });
      autoBlurry++;
    }
  }

  return { dest, root, move, dryRun, autoSharp, autoBlurry, review, failed, total };
}

/**
 * Apply a review decision. "keep" leaves the frame in place; "discard" relocates
 * it into --dest, mirroring the source structure. Returns the file's resting path.
 */
export function commitDecision(
  root: string,
  dest: string,
  file: string,
  decision: ReviewDecision,
  options: { move: boolean },
): Promise<string> {
  if (decision === 'keep') return Promise.resolve(file);
  return relocate(root, file, dest, { move: options.move });
}
