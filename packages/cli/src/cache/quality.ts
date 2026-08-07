/**
 * The cached half of quality assessment, shared by `rate`, `embeddings` and
 * `develop export` — the three commands that today embed the same photographs
 * independently of one another.
 *
 * Two producers meet here, and that is the point. Sharpness comes off the same
 * decode as the embedding, and it is the very number `cull` already stores, so a
 * shoot that was culled hands `rate` its focus for free; a shoot that was rated
 * hands `cull` nothing to do. Whichever ran first paid.
 *
 * What is cached is the measurement. Stars, keywords and aspects are derived
 * per run under whichever `--profile` was named, so changing profile re-reads
 * kilobytes instead of re-running a model.
 */
import type { ScannedFile } from '@shoots/core';
import type { LaplacianResult } from '@shoots/imaging';
import { measureBlur } from '@shoots/imaging';
import type { QualityMeasurement, QualityModel } from '@shoots/inference';
import { BLUR_ANALYSIS_MAX_DIMENSION, type CachedMeasurement } from './blur.js';
import { decodeFloats, encodeFloats } from './codec.js';
import { blurProducer, clipProducer } from './producers.js';
import type { DerivedCache, FileIdentity } from './store.js';

/** How the CLIP half is stored: the vector, and the stats only some archives need. */
interface CachedEmbedding {
  /** base64 float32, see codec.ts. */
  e: string;
  /** Present only for archives with no aesthetics head. */
  stats?: QualityMeasurement['stats'];
}

/** Read and decode in one step, so a corrupt entry is a miss and not a crash. */
function readEmbedding(
  cache: DerivedCache,
  file: string,
  producer: string,
  identity: FileIdentity,
): { embedding: Float32Array; stats: CachedEmbedding['stats'] } | null {
  const raw = cache.get<CachedEmbedding>(file, producer, identity);
  if (!raw) return null;
  const embedding = decodeFloats(raw.e);
  if (!embedding) return null;
  return { embedding, stats: raw.stats };
}

/**
 * Measure `file` for quality, reusing whichever halves a previous run left
 * behind, and store whatever had to be computed.
 *
 * Three outcomes, in descending order of luck:
 *  - both halves cached — nothing is decoded at all;
 *  - sharpness cached, embedding not — one decode, and the Laplacian is skipped;
 *  - embedding cached, sharpness not — one decode, and the model is skipped.
 */
export async function measureQualityCached(
  cache: DerivedCache,
  model: QualityModel,
  file: ScannedFile,
): Promise<QualityMeasurement> {
  const identity = { size: file.size, mtimeMs: file.mtime.getTime() };
  const blurKey = blurProducer(BLUR_ANALYSIS_MAX_DIMENSION);
  const clipKey = clipProducer(model.name);

  const cachedBlur = cache.get<CachedMeasurement>(file.path, blurKey, identity);
  const cachedClip = readEmbedding(cache, file.path, clipKey, identity);

  if (cachedBlur && cachedClip) {
    return { embedding: cachedClip.embedding, focusPeak: cachedBlur.measured.focusPeak, stats: cachedClip.stats };
  }

  if (cachedClip) {
    // The model's work is done; only sharpness is missing. Measuring it alone
    // costs a decode but not a forward pass.
    const measured = await measureBlur(file.path, { maxDimension: BLUR_ANALYSIS_MAX_DIMENSION });
    cache.set(file.path, blurKey, identity, measured satisfies CachedMeasurement);
    await cache.flushIfDue();
    return { embedding: cachedClip.embedding, focusPeak: measured.measured.focusPeak, stats: cachedClip.stats };
  }

  // The embedding has to be computed, and that decode can carry the Laplacian
  // too when it is not already known.
  const measurement = await model.measure(
    { path: file.path },
    cachedBlur ? { focusPeak: cachedBlur.measured.focusPeak } : {},
  );
  cache.set(file.path, clipKey, identity, {
    e: encodeFloats(measurement.embedding),
    ...(measurement.stats ? { stats: measurement.stats } : {}),
  } satisfies CachedEmbedding);

  // Only when this call did the measuring: a Laplacian handed in from the cache
  // comes back absent, and re-storing it would be writing what we just read.
  if (measurement.laplacian && measurement.pixelSource) {
    cache.set(file.path, blurKey, identity, {
      measured: measurement.laplacian satisfies LaplacianResult,
      pixelSource: measurement.pixelSource,
    } satisfies CachedMeasurement);
  }
  // An embedding is the most expensive thing here by far; do not hold hours of
  // them in memory waiting for the run to end.
  await cache.flushIfDue();
  return measurement;
}

/** Measure and interpret in one call, which is what most callers want. */
export async function assessCached(
  cache: DerivedCache,
  model: QualityModel,
  file: ScannedFile,
): Promise<ReturnType<QualityModel['interpret']>> {
  return model.interpret(await measureQualityCached(cache, model, file));
}
