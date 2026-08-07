/**
 * The cached half of blur analysis, shared by batch `cull` and the shell's
 * interactive review so both read and write the same entries.
 *
 * What is stored is the *measurement*, never the verdict: the thresholds are
 * this run's opinion and re-deriving them is arithmetic, so a photographer
 * chasing the right `--threshold` pays the decode once instead of once per
 * attempt.
 */
import { classifyBlur, measureBlur, type BlurAnalysis, type LaplacianResult } from '@shoots/imaging';
import type { ScannedFile } from '@shoots/core';
import { blurProducer } from './producers.js';
import type { DerivedCache } from './store.js';

/**
 * Analysis size, pinned rather than left to the default. It is part of the
 * cache key: a measurement taken at another size is a different number, and the
 * entry has to say which one it is.
 */
export const BLUR_ANALYSIS_MAX_DIMENSION = 1024;

/** Everything a verdict needs that costs a decode to obtain. */
export interface CachedMeasurement {
  measured: LaplacianResult;
  pixelSource: 'file' | 'embedded-preview';
}

export interface ClassifyOptions {
  threshold?: number;
  focusThreshold?: number;
  focusRescue?: boolean;
}

/**
 * Measure `file`, reusing what a previous run worked out when the photograph is
 * unchanged, then classify it under this run's thresholds.
 *
 * A hit and a miss produce the same object; the only difference is whether the
 * pixels were decoded to get there.
 */
export async function analyzeBlurCached(
  cache: DerivedCache,
  file: ScannedFile,
  options: ClassifyOptions,
): Promise<BlurAnalysis> {
  const producer = blurProducer(BLUR_ANALYSIS_MAX_DIMENSION);
  const identity = { size: file.size, mtimeMs: file.mtime.getTime() };

  const cached = cache.get<CachedMeasurement>(file.path, producer, identity);
  if (cached) return classifyBlur(file.path, cached.measured, cached.pixelSource, options);

  const measured = await measureBlur(file.path, { maxDimension: BLUR_ANALYSIS_MAX_DIMENSION });
  cache.set(file.path, producer, identity, measured satisfies CachedMeasurement);
  // Get it to disk periodically rather than only at the end: a long run that is
  // interrupted should keep what it already measured.
  await cache.flushIfDue();
  return classifyBlur(file.path, measured.measured, measured.pixelSource, options);
}
