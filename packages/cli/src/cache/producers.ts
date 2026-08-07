/**
 * Who produced a cached value, and under which rules.
 *
 * A cache key is only as trustworthy as its version. Every entry is namespaced
 * by one of the strings below, and **the version must be bumped whenever the
 * computation behind it changes** — a new Laplacian kernel, a different default
 * analysis size, a re-quantized model. Forget to bump it and the cache serves
 * yesterday's arithmetic under today's name, which is the one failure mode this
 * whole subsystem must not have: a miss costs time, a wrong hit costs trust.
 *
 * Parameters that change the *value* belong in the key rather than in a version
 * bump — see {@link blurProducer}, where the analysis size does. Parameters that
 * only change how a value is *interpreted* (a threshold, a rating profile) must
 * not: those are exactly what re-running cheaply is for.
 */

/**
 * Laplacian measurement: score, focus peak and the tile grid.
 *
 * v1 — variance of the 4-neighbour Laplacian over a grayscale frame bounded to
 * `maxDimension`, with the robust top-tile focus peak.
 */
export function blurProducer(maxDimension: number): string {
  return `blur@1:d${maxDimension}`;
}

/**
 * CLIP image embedding, plus the sharpness and statistics that come off the
 * same decode.
 *
 * `modelName` already carries the archive version (`onnx-clip/vit-b32-int8-2`),
 * so re-quantizing or re-exporting the encoder namespaces itself. What the
 * leading version covers is everything around the weights: the preprocessing
 * crop, the normalization constants, the L2 step.
 *
 * v1 — shortest edge to 224, centre crop, CLIP mean/std, L2-normalized output.
 */
export function clipProducer(modelName: string): string {
  return `clip@1:${modelName}`;
}

/** Every producer prefix in use, for pruning entries nothing reads any more. */
export const PRODUCER_PREFIXES = ['blur@', 'clip@'] as const;
