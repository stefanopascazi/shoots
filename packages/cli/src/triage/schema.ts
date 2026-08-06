/**
 * The canonical vocabulary of a triage mark.
 *
 * What `cull` and `rate` decide about a photograph is *meaning*, not
 * presentation: "this one is a reject", "this one is worth four stars". The
 * colour that meaning wears is the editor's business — Lightroom localizes its
 * label names, darktable has five unnamed slots, Capture One keeps its own set.
 * Storing "Red" here would mean choosing for the editor before we know which one
 * the photographer uses; storing `reject` leaves the choice to the adapter (see
 * develop/adapters/types.ts, which draws the same line for develop settings).
 *
 * The store is therefore editor-agnostic by construction, and a photographer who
 * moves to darktable next year remaps one JSON file instead of re-culling.
 */
import path from 'node:path';

/** Semantic labels a producer may attach. Mapped to a colour by the adapter. */
export const SEMANTIC_LABELS = ['reject', 'select', 'review', 'second-pass'] as const;
export type SemanticLabel = (typeof SEMANTIC_LABELS)[number];

export function isSemanticLabel(value: string): value is SemanticLabel {
  return (SEMANTIC_LABELS as readonly string[]).includes(value);
}

/**
 * What a producer decided, in the canonical vocabulary. Every field optional:
 * `cull` speaks about rejection, `rate` about stars, and neither should have to
 * invent a value for what it knows nothing about.
 */
export interface TriageMarks {
  /** The frame is a reject. Kept separate from `label` — meaning vs presentation. */
  reject?: boolean;
  /** Star rating, 0–5. */
  stars?: number;
  /** Semantic label; the adapter maps it onto the editor's own colour set. */
  label?: SemanticLabel;
  /** Free keywords (dc:subject on the way out). */
  keywords?: string[];
}

/** Producers that may write into a record's `sources`. */
export type MarkSource = 'cull' | 'rate' | 'manual';

/** Provenance for one producer: diagnostic only, never read by the emitters. */
export interface MarkProvenance {
  /** `<command>@<version>`, so a mark from an older build is recognisable. */
  tool: string;
  /** ISO timestamp. */
  at: string;
  /** Whatever the producer wants to remember (scores, thresholds, aspects). */
  [key: string]: unknown;
}

/** One photograph's pending marks. */
export interface TriageRecord {
  /** Absolute path, the identity key (see store.ts on why, and its limits). */
  file: string;
  /** Size + mtime at mark time: detects a file replaced under our feet. */
  size: number;
  mtimeMs: number;
  /** The canonical decision, merged across producers. */
  marks: TriageMarks;
  /** Per-producer provenance, namespaced so a new producer breaks no reader. */
  sources: Partial<Record<MarkSource, MarkProvenance>>;
  /**
   * Set once the marks have reached a sidecar. Soft consume: the record stays
   * so a deleted sidecar can be re-emitted and a half-finished run is
   * recoverable, but it is no longer pending. `triage clean` purges these.
   */
  applied?: { at: string; sidecar: string };
}

/** Merge new marks over existing ones. Later producers win field by field. */
export function mergeMarks(base: TriageMarks, incoming: TriageMarks): TriageMarks {
  return {
    ...base,
    ...Object.fromEntries(Object.entries(incoming).filter(([, v]) => v !== undefined)),
  };
}

/** A record that has never been written into any sidecar. */
export function isPending(record: TriageRecord): boolean {
  return !record.applied;
}

/**
 * Compare two sidecar paths. Case-insensitively on Windows, where the same UNC
 * share reached twice can differ only in case, and exactly elsewhere.
 */
export function sameSidecar(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Does this record still need writing into `sidecar`?
 *
 * "Applied" is only ever true of the sidecar it was applied *to*. A mark
 * consumed against some other path — which is what a run with a wrong sidecar
 * location leaves behind — never reached this photograph, so it is still owed
 * one. Checking the recorded destination rather than a bare flag is what lets a
 * catalog heal itself on the next pass instead of needing a manual --redo.
 */
export function needsApplying(record: TriageRecord, sidecar: string): boolean {
  if (!record.applied) return true;
  return !sameSidecar(record.applied.sidecar, sidecar);
}

/**
 * Parse one JSONL line into a record, or null when it is unusable.
 *
 * Lenient on purpose: the store is append-only and a truncated last line after
 * a crash must not take the whole shoot's marks down with it.
 */
export function parseRecord(line: string): TriageRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Partial<TriageRecord>;
  if (typeof rec.file !== 'string' || !rec.file) return null;
  return {
    file: rec.file,
    size: typeof rec.size === 'number' ? rec.size : 0,
    mtimeMs: typeof rec.mtimeMs === 'number' ? rec.mtimeMs : 0,
    marks: rec.marks && typeof rec.marks === 'object' ? rec.marks : {},
    sources: rec.sources && typeof rec.sources === 'object' ? rec.sources : {},
    ...(rec.applied ? { applied: rec.applied } : {}),
  };
}
