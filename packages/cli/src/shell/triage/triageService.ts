/**
 * Interactive-cull orchestration, in-process (the batch `shoots cull` stays
 * non-interactive). Analyses a folder, disposes of the confident rejects, leaves
 * the keepers in place, and hands back the uncertain frames (the focus-peak
 * "rescued" shots) for the shell to review one by one.
 *
 * "Disposes of" is one of two things, and the review has to speak both or the
 * interactive path would be the only one that still insists on reorganizing a
 * catalog to record a decision:
 *
 *   - RELOCATE (`dest`): rejects move to --dest, mirroring the source structure;
 *     `copy` leaves the originals in place.
 *   - MARK (`mark`): nothing moves at all — the verdict goes to the triage store
 *     and a sidecar writer renders it later (see ../../triage/store.ts).
 *
 * Keepers are never touched, and nothing is ever deleted, either way.
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import { defaultImageConcurrency, JobQueue, scanFiles } from '@shoots/core';
import { readMetadata, type FocusMap } from '@shoots/imaging';
import { analyzeBlurCached } from '../../cache/blur.js';
import { DerivedCache } from '../../cache/store.js';
import { relocate, relocateAll } from '../../relocate.js';
import { TriageStore } from '../../triage/store.js';
import type { SemanticLabel } from '../../triage/schema.js';
import { VERSION } from '../../version.js';

export interface ReviewItem {
  file: string;
  name: string;
  score: number;
  focusPeak: number;
  aperture: number | null;
  focusMap: FocusMap;
}

export type ReviewDecision = 'keep' | 'discard';

/** How a reject is disposed of. Exactly one of the two is configured. */
export interface TriageDisposition {
  /** Relocate rejects here, mirroring the source structure. */
  dest?: string;
  /** Or: record the verdict as a triage mark and move nothing. */
  mark?: { label: SemanticLabel; keepers?: SemanticLabel };
}

export interface TriageResult {
  /** Where rejects went, or null when marking (nothing moved). */
  dest: string | null;
  /** The mark configuration in force, or null when relocating. */
  mark: { label: SemanticLabel; keepers?: SemanticLabel } | null;
  /** Scan root the rejects mirror under (needed to relocate review decisions). */
  root: string;
  /** Move rejects (default) or copy them. Meaningless when marking. */
  move: boolean;
  /** Whether this was a dry run (nothing written; counts are what *would* happen). */
  dryRun: boolean;
  /** Confident keepers left in place. */
  autoSharp: number;
  /** Confident rejects disposed of (or that would be, in a dry run). */
  autoBlurry: number;
  /** Uncertain (rescued) frames awaiting a decision. */
  review: ReviewItem[];
  failed: { file: string; error: string }[];
  total: number;
}

export interface TriageOptions extends TriageDisposition {
  threshold?: number;
  focusThreshold?: number;
  concurrency?: number;
  /** Copy rejects instead of moving them. Ignored when marking. */
  copy?: boolean;
  /** Analyse and queue for review, but write nothing. */
  dryRun?: boolean;
  /** Re-measure every frame instead of reusing a previous run's numbers. */
  cache?: boolean;
  onProgress?: (done: number, total: number) => void;
}

const normalizePath = (p: string): string => p.replace(/\\/g, '/');

/** Provenance recorded with every mark this service writes. */
function provenance(r: { verdict: string; score: number; focusPeak: number; rescued: boolean }, reviewed: boolean) {
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  return {
    tool: `cull-review@${VERSION}`,
    verdict: r.verdict,
    score: round2(r.score),
    focusPeak: round2(r.focusPeak),
    rescued: r.rescued,
    // The one thing the batch path cannot record: a human looked at this frame.
    reviewed,
  };
}

/** Analyse a folder, dispose of the confident rejects, queue the rest. */
export async function runTriage(targetPath: string, options: TriageOptions): Promise<TriageResult> {
  const dryRun = options.dryRun ?? false;
  const move = !options.copy;
  const mark = options.mark ?? null;
  const dest = options.dest ? path.resolve(options.dest) : null;
  if (!dest && !mark) throw new Error('triage needs either a reject destination or a mark label');
  // Root the mirror at the scanned folder; a single-file target mirrors by basename.
  const root = statSync(targetPath).isDirectory()
    ? path.resolve(targetPath)
    : path.dirname(path.resolve(targetPath));
  // Never re-scan our own output if --dest sits inside the target.
  const destPrefix = dest ? dest + path.sep : null;
  const files = (await scanFiles(targetPath)).filter(
    (f) => !dest || (f.path !== dest && !f.path.startsWith(destPrefix!)),
  );
  const total = files.length;

  // Same split, and the same pack files, as the batch `cull`: measuring is the
  // expensive half and does not depend on the thresholds this session chose, so
  // a review opened twice on the same folder measures once.
  const cache = await DerivedCache.open(files.map((f) => f.path), { enabled: options.cache !== false });
  const classifyOptions = { threshold: options.threshold, focusThreshold: options.focusThreshold };

  const queue = new JobQueue({ concurrency: options.concurrency ?? defaultImageConcurrency() });
  let done = 0;
  const outcomes = await queue.run(
    files,
    (file) => analyzeBlurCached(cache, file, classifyOptions),
    () => options.onProgress?.(++done, total),
    (file) => file.name,
  );
  await cache.save();

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

  // One store for the whole auto pass; the review decisions that follow open
  // their own, since they arrive minutes apart at human pace.
  const store = mark && !dryRun ? await TriageStore.open(root) : null;

  // Rejects are collected and relocated together after the pass: moving them one
  // at a time follows their triage marks one at a time, and each of those is a
  // rewrite of every store file on the machine.
  const toRelocate: string[] = [];

  for (const o of outcomes) {
    if (!o.ok || !o.value) {
      failed.push({ file: o.item.path, error: o.error?.message ?? 'unknown error' });
      continue;
    }
    const r = o.value;
    // The scan already reported both; the store need not stat the file again.
    const stats = { size: o.item.size, mtimeMs: o.item.mtime.getTime() };
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
      if (store && mark?.keepers) {
        await store.mark(r.file, { reject: false, label: mark.keepers }, 'cull', provenance(r, false), stats);
      }
    } else {
      if (!dryRun) {
        if (store) await store.mark(r.file, { reject: true, label: mark!.label }, 'cull', provenance(r, false), stats);
        else toRelocate.push(r.file);
      }
      autoBlurry++;
    }
  }
  if (toRelocate.length > 0) {
    const outcome = await relocateAll(root, toRelocate, dest!, { move });
    // A frame that would not move is reported rather than aborting the pass —
    // the same treatment its analysis failing would have got.
    failed.push(...outcome.errors);
  }
  await store?.save();

  return { dest, mark, root, move, dryRun, autoSharp, autoBlurry, review, failed, total };
}

/**
 * Apply one review decision, in whichever mode the session is running.
 *
 * Relocating: "discard" moves the frame into --dest, mirroring the source
 * structure, and the returned path is where it now lives.
 * Marking: nothing moves — "discard" records the reject label, "keep" records
 * the keeper label when one was configured, and the path comes back unchanged.
 *
 * A human decided these, so they carry `reviewed: true` into the store: a mark
 * somebody actually looked at should not read like one a threshold produced.
 */
export async function commitDecision(
  root: string,
  disposition: TriageDisposition,
  file: string,
  decision: ReviewDecision,
  options: { move: boolean; score?: number; focusPeak?: number },
): Promise<string> {
  const { dest, mark } = disposition;

  if (mark) {
    const label = decision === 'discard' ? mark.label : mark.keepers;
    if (!label) return file; // keeping, with no keeper label configured: nothing to record
    const store = await TriageStore.open(root);
    await store.mark(
      file,
      { reject: decision === 'discard', label },
      'cull',
      provenance(
        {
          verdict: decision === 'discard' ? 'blurry' : 'sharp',
          score: options.score ?? 0,
          focusPeak: options.focusPeak ?? 0,
          rescued: true, // only rescued frames ever reach the review
        },
        true,
      ),
    );
    await store.save();
    return file;
  }

  if (decision === 'keep') return file;
  return relocate(root, file, dest!, { move: options.move });
}
