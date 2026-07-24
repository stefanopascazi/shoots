/**
 * Interactive-cull orchestration, in-process (the batch `shoots cull` stays
 * non-interactive). Analyses a folder, auto-sorts the confident verdicts into
 * sharp/ and blurry/ copies, and hands back the uncertain frames (the
 * focus-peak "rescued" shots) for the shell to review one by one.
 *
 * Strictly non-destructive, like cull: everything is a copy. "Discard" during
 * review copies into blurry/ for the user to delete later — never unlinks.
 */
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { JobQueue, scanFiles } from '@shoots/core';
import { analyzeBlur, readMetadata, type FocusMap } from '@shoots/imaging';

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
  /** Whether this was a dry run (nothing copied; counts are what *would* happen). */
  dryRun: boolean;
  /** Confident keepers copied into dest/sharp (or that would be, in a dry run). */
  autoSharp: number;
  /** Confident rejects copied into dest/blurry (or that would be, in a dry run). */
  autoBlurry: number;
  /** Uncertain (rescued) frames awaiting a decision. */
  review: ReviewItem[];
  failed: { file: string; error: string }[];
  total: number;
}

export interface TriageOptions {
  dest?: string;
  threshold?: number;
  focusThreshold?: number;
  concurrency?: number;
  /** Analyse and queue for review, but copy nothing. */
  dryRun?: boolean;
  onProgress?: (done: number, total: number) => void;
}

const normalizePath = (p: string): string => p.replace(/\\/g, '/');

/** Copy `file` into `dest/<bucket>/`, returning the written path. */
async function copyInto(dest: string, bucket: 'sharp' | 'blurry', file: string): Promise<string> {
  const dir = path.join(dest, bucket);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, path.basename(file));
  await copyFile(file, target);
  return target;
}

const bucketOf = (decision: ReviewDecision): 'sharp' | 'blurry' =>
  decision === 'keep' ? 'sharp' : 'blurry';

/** Analyse a folder, auto-file the confident verdicts, queue the rest. */
export async function runTriage(targetPath: string, options: TriageOptions = {}): Promise<TriageResult> {
  const dryRun = options.dryRun ?? false;
  const dest = path.resolve(options.dest ?? path.join(targetPath, '_culled'));
  // Never re-scan our own output: the default dest lives inside the target, so
  // a second run would otherwise pick up the sharp/ and blurry/ copies.
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
      if (!dryRun) await copyInto(dest, 'sharp', r.file);
      autoSharp++;
    } else {
      if (!dryRun) await copyInto(dest, 'blurry', r.file);
      autoBlurry++;
    }
  }

  return { dest, dryRun, autoSharp, autoBlurry, review, failed, total };
}

/** Apply a review decision: copy the frame into its chosen bucket. */
export function commitDecision(dest: string, file: string, decision: ReviewDecision): Promise<string> {
  return copyInto(dest, bucketOf(decision), file);
}
