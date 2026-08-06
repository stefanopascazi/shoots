/**
 * The one place triage marks become files on disk.
 *
 * `cull` and `rate` record fragments and touch nothing; this module decides
 * *which* of them are owed a sidecar and hands each to the adapter, which owns
 * the write. Two callers reach it: `develop edit`, which has just written its
 * develop template and wants the annotations merged on top, and `shoots triage
 * apply`, for the photographer who culls and rates without ever running a
 * prediction.
 *
 * Nothing here knows what a sidecar looks like. It used to: the merge went
 * through exiftool and the empty file it created was RDF, which made every
 * non-Adobe editor a special case of Adobe. Ownership now stops at the adapter
 * boundary, and this module is the bookkeeping either side of it.
 *
 * Marks are consumed softly on success (see store.ts) — applied, not deleted.
 */
import path from 'node:path';
import type { AnnotationTags, EditAdapter } from '../develop/adapters/types.js';
import { resolveLabelSet, type LabelSet } from './labelSets.js';
import { needsApplying, type TriageRecord } from './schema.js';
import { consumeMarks, readMarks } from './store.js';

export interface ApplyOptions {
  /** Rewrite marks that already reached a sidecar (default: pending only). */
  includeApplied?: boolean;
  /** Resolve everything and report, write nothing. */
  dryRun?: boolean;
}

export interface AppliedMark {
  file: string;
  sidecar: string;
  tags: Record<string, unknown>;
}

export interface ApplyResult {
  applied: AppliedMark[];
  /** Files that carried marks but nothing the adapter could express. */
  skipped: string[];
  errors: { file: string; error: string }[];
}

/**
 * Write the marks held for `files` into their sidecars.
 *
 * `sidecarFor` decides where a photograph's sidecar lives, so `develop edit` can
 * point at the file it just templated and `triage apply` at the photograph's own
 * folder — the two do not have to agree on a directory.
 */
export async function applyMarks(
  adapter: EditAdapter,
  files: readonly string[],
  sidecarFor: (file: string) => string,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const result: ApplyResult = { applied: [], skipped: [], errors: [] };
  if (!adapter.writeMarks) return result;

  const marks = await readMarks(files);
  if (marks.size === 0) return result;

  const labels = await resolveLabelSet(adapter.id);
  const consumed = new Map<string, string>();

  for (const file of files) {
    const record = marks.get(path.resolve(file));
    if (!record) continue;

    const sidecar = sidecarFor(file);
    if (!options.includeApplied && !needsApplying(record, sidecar)) continue;

    // A dry run must not reach the adapter at all: the write and the decision of
    // what to write are one call there, and they are one call because the two
    // editors disagree on what a sidecar even is. So the preview is reconstructed
    // from the marks instead — it says what would be written, not how.
    if (options.dryRun) {
      const preview = previewMarks(record, labels);
      if (Object.keys(preview).length === 0) result.skipped.push(file);
      else result.applied.push({ file, sidecar, tags: preview });
      continue;
    }

    let tags: AnnotationTags;
    try {
      tags = await adapter.writeMarks(record.marks, labels, sidecar);
    } catch (err) {
      result.errors.push({ file, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (Object.keys(tags).length === 0) {
      result.skipped.push(file);
      continue;
    }
    consumed.set(file, sidecar);
    result.applied.push({ file, sidecar, tags });
  }

  if (!options.dryRun) await consumeMarks(consumed);
  return result;
}

/**
 * What a `--dry-run` reports, in the canonical vocabulary rather than the
 * editor's. Deliberately not routed through the adapter: asking it to describe a
 * write without performing one would be a second code path that only ever runs
 * under a flag, which is the kind that quietly stops matching the first.
 */
function previewMarks(record: TriageRecord, labels: LabelSet): AnnotationTags {
  const preview: AnnotationTags = {};
  const label = record.marks.label ?? (record.marks.reject ? 'reject' : undefined);
  if (label) preview['label'] = labels[label];
  if (typeof record.marks.stars === 'number') preview['rating'] = record.marks.stars;
  if (record.marks.keywords?.length) preview['keywords'] = record.marks.keywords;
  return preview;
}

/**
 * How many of `files` still owe their sidecar a mark.
 *
 * Takes the same `sidecarFor` as {@link applyMarks} and must answer identically:
 * this is what decides whether exiftool gets provisioned, and a count that said
 * "none" while the write then had work to do would fail mid-catalog.
 */
export async function countPending(
  files: readonly string[],
  sidecarFor: (file: string) => string,
): Promise<number> {
  const marks = await readMarks(files);
  let n = 0;
  for (const file of files) {
    const record = marks.get(path.resolve(file));
    if (record && needsApplying(record, sidecarFor(file))) n++;
  }
  return n;
}

export type { LabelSet, TriageRecord };
