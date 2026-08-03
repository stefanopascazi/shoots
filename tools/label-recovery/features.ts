/**
 * Photometric features for every image in a photometric-pairs dataset.
 *
 * Uses the *shipped* extractor from `@shoots/imaging` rather than a copy: the
 * whole question this experiment answers is whether the features the develop
 * predictor already has can recover the degradation, so re-implementing them
 * would answer a different question.
 */
import { createReadStream } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { COLOR_FEATURE_NAMES, extractColorFeatures } from '@shoots/imaging';

export { COLOR_FEATURE_NAMES };

/** Feature vectors already computed, keyed by sample id. */
export async function readCache(file: string): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  try {
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { id: string; v: number[] };
        if (row.id && Array.isArray(row.v)) out.set(row.id, row.v);
      } catch {
        // A run killed mid-write leaves one torn line; the sample is simply
        // recomputed rather than poisoning the cache.
      }
    }
  } catch {
    // no cache yet
  }
  return out;
}

export interface ExtractTarget {
  id: string;
  /** Path to the image, relative to the dataset root. */
  image: string;
}

/**
 * Extract whatever is missing from `cache`, appending to it as it goes.
 *
 * Appending rather than writing at the end is what makes a 38k-image run safe to
 * interrupt: the work already done survives.
 */
export async function ensureFeatures(
  root: string,
  cacheFile: string,
  targets: ExtractTarget[],
  cache: Map<string, number[]>,
  opts: { jobs: number; onProgress?: (done: number, total: number) => void },
): Promise<void> {
  const missing = targets.filter((t) => !cache.has(t.id));
  if (missing.length === 0) return;
  await mkdir(path.dirname(cacheFile), { recursive: true });

  let cursor = 0;
  let done = 0;
  // One append per batch: 38k individual appendFile calls cost more than the
  // feature extraction itself.
  const flushEvery = 200;
  let pending: string[] = [];
  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    await appendFile(cacheFile, `${batch.join('\n')}\n`, 'utf8');
  };

  const workers = Array.from({ length: Math.min(opts.jobs, missing.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= missing.length) break;
      const t = missing[i]!;
      try {
        const { vector } = await extractColorFeatures(path.join(root, t.image));
        cache.set(t.id, vector);
        pending.push(JSON.stringify({ id: t.id, v: vector.map((v) => Math.round(v * 1e6) / 1e6) }));
      } catch {
        // A sample that cannot be decoded is dropped rather than zero-filled: a
        // zero vector is a lie the fit cannot distinguish from a real reading.
      }
      done++;
      if (pending.length >= flushEvery) await flush();
      if (done % 250 === 0) opts.onProgress?.(done, missing.length);
    }
  });
  await Promise.all(workers);
  await flush();
  opts.onProgress?.(done, missing.length);
}
