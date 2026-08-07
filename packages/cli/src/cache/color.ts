/**
 * The cached colour-feature vector, for `develop export` and everything built on
 * it (`develop init`, `develop edit`).
 *
 * This is the third and last thing the export pass pays per photograph, after
 * the embedding and the sharpness — and the most expensive per frame under
 * `--baseline external`, where it means shelling out to a RAW developer for a
 * neutral render before a single number is computed.
 *
 * Unlike the other two, these features are not one number per photograph: what
 * they describe is a *rendering*, and the same RAW gives different answers off
 * its embedded preview and off a neutral external render. The producer key
 * carries which one, so the two never answer for each other.
 */
import { COLOR_FEATURE_NAMES } from '@shoots/imaging';
import { decodeDoubles, encodeDoubles } from './codec.js';
import { colorProducer } from './producers.js';
import type { DerivedCache, FileIdentity } from './store.js';

/** How the vector is stored: base64 float64, see codec.ts. */
interface CachedColor {
  v: string;
}

/**
 * The colour features for `file` under `source`, computing them only if no run
 * has already done so for that same rendering.
 *
 * A cached vector of the wrong width is refused. That should be impossible —
 * changing the feature set is supposed to bump the producer version — but it is
 * the one mistake that would be invisible otherwise, and catching it costs a
 * length comparison.
 */
export async function colorFeaturesCached(
  cache: DerivedCache,
  file: string,
  identity: FileIdentity,
  source: string,
  compute: () => Promise<number[]>,
): Promise<number[]> {
  const producer = colorProducer(source);
  const cached = cache.get<CachedColor>(file, producer, identity);
  if (cached) {
    const vector = decodeDoubles(cached.v);
    if (vector && vector.length === COLOR_FEATURE_NAMES.length) return vector;
  }
  const vector = await compute();
  cache.set(file, producer, identity, { v: encodeDoubles(vector) } satisfies CachedColor);
  return vector;
}
