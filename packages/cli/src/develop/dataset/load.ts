/**
 * Load a `shoots develop-export` dataset.
 *
 * The current format is JSONL: one record per line plus a trailing
 * `_type: "develop-meta"` line carrying the dataset-level fields. For backward
 * compatibility we also accept the legacy format (a single pretty-printed JSON
 * object with a `results` array).
 *
 * Training needs every row in memory anyway (the ridge is a batch solve), so we
 * read the whole file — the streaming write is what keeps *export* memory flat.
 */
import { readFile } from 'node:fs/promises';
import type { DevelopDataset, DevelopExportResult } from '../types.js';

interface MetaLine {
  _type: 'develop-meta';
  model: string;
  dim: number;
  colorDim: number;
  colorFeatureNames?: string[];
  baseline: string;
  looks?: Record<string, string>;
  toolVersion?: string;
}

export async function loadDataset(file: string): Promise<DevelopDataset> {
  const text = await readFile(file, 'utf8');

  // Legacy: the whole file is a single develop-export JSON object.
  try {
    const obj = JSON.parse(text) as Partial<DevelopDataset>;
    if (obj && obj.command === 'develop-export' && Array.isArray(obj.results)) {
      // Older exports kept the baseline on every record instead of on the
      // dataset. Lift it up, so the applicability guard has the real value to
      // compare rather than `undefined` (which reads as a mismatch).
      return { ...obj, baseline: obj.baseline ?? obj.results[0]?.baseline } as DevelopDataset;
    }
  } catch {
    // Not a single JSON object → JSONL below.
  }

  // JSONL: records (no `_type`) + one trailing meta line.
  const results: DevelopExportResult[] = [];
  let meta: MetaLine | null = null;
  let lineNo = 0;
  for (const raw of text.split('\n')) {
    lineNo++;
    const line = raw.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      throw new Error(`${file}:${lineNo}: invalid JSON line (${err instanceof Error ? err.message : String(err)})`);
    }
    if (obj && typeof obj === 'object' && (obj as { _type?: string })._type === 'develop-meta') {
      meta = obj as MetaLine;
    } else {
      results.push(obj as DevelopExportResult);
    }
  }
  if (!meta) {
    throw new Error(`${file}: no develop-meta line found — dataset is incomplete or corrupt (export may have been interrupted)`);
  }
  return {
    command: 'develop-export',
    model: meta.model,
    dim: meta.dim,
    colorFeatureNames: meta.colorFeatureNames ?? [],
    colorDim: meta.colorDim,
    baseline: meta.baseline,
    ...(meta.looks ? { looks: meta.looks } : {}),
    ...(meta.toolVersion ? { toolVersion: meta.toolVersion } : {}),
    results,
  };
}
