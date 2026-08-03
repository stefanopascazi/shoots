/**
 * The one place triage marks become files on disk.
 *
 * `cull` and `rate` record fragments and touch nothing; this module reconstructs
 * them in the target editor's vocabulary and merges them into a sidecar. Two
 * callers reach it: `develop edit`, which has just written its `crs:` template
 * and wants the annotations merged on top, and `shoots triage apply`, for the
 * photographer who culls and rates without ever running a prediction.
 *
 * Marks are consumed softly on success (see store.ts) — applied, not deleted.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mergeIntoSidecar } from '../develop/adapters/acr/preserve.js';
import type { EditAdapter } from '../develop/adapters/types.js';
import { resolveLabelSet, type LabelSet } from './labelSets.js';
import { needsApplying, type TriageRecord } from './schema.js';
import { consumeMarks, readMarks } from './store.js';

/** An empty sidecar for annotations to be merged into, when none exists yet. */
const EMPTY_XMP = `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""/>
 </rdf:RDF>
</x:xmpmeta>
`;

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
  if (!adapter.annotate) return result;

  const marks = await readMarks(files);
  if (marks.size === 0) return result;

  const labels = await resolveLabelSet(adapter.id);
  const consumed = new Map<string, string>();

  for (const file of files) {
    const record = marks.get(path.resolve(file));
    if (!record) continue;

    const sidecar = sidecarFor(file);
    if (!options.includeApplied && !needsApplying(record, sidecar)) continue;

    const tags = adapter.annotate(record.marks, labels);
    if (Object.keys(tags).length === 0) {
      result.skipped.push(file);
      continue;
    }

    if (!options.dryRun) {
      try {
        await ensureSidecar(sidecar);
        await mergeIntoSidecar(sidecar, tags);
      } catch (err) {
        result.errors.push({ file, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      consumed.set(file, sidecar);
    }
    result.applied.push({ file, sidecar, tags });
  }

  if (!options.dryRun) await consumeMarks(consumed);
  return result;
}

/** Create a minimal sidecar when there is none, so exiftool has a file to merge into. */
async function ensureSidecar(sidecarPath: string): Promise<void> {
  if (existsSync(sidecarPath)) return;
  await mkdir(path.dirname(sidecarPath), { recursive: true });
  await writeFile(sidecarPath, EMPTY_XMP, 'utf8');
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
