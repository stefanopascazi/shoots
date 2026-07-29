/**
 * Principal components of the CLIP embedding.
 *
 * The embedding is 512-dimensional and a personal catalog is a few hundred
 * photographs, so feeding it raw is p≫n: ridge shrinks the whole block towards
 * nothing, and on the reference catalog it did worse than that — carrying the
 * raw embedding *halved* colour skill against simply dropping it (0.019 vs
 * 0.046, losing on 12 fold shuffles out of 12). Not because scene content is
 * irrelevant, but because 512 noisy directions estimated from 428 samples cost
 * more than they pay.
 *
 * Projecting onto a handful of directions fixes the conditioning while keeping
 * the semantic signal — which matters on the black-and-white branch, where the
 * embedding genuinely carries the conversion decision (dropping it there helped
 * on only 4 shuffles out of 12).
 *
 * Fitted with power iteration and deflation rather than a full eigendecomposition:
 * we want the top k≈16 of 512, and k passes over the data beat factorising a
 * 512×512 covariance for components nobody reads.
 */

export interface PcaModel {
  /** Per-dimension mean, subtracted before projecting. */
  mean: number[];
  /** k unit-length directions, each of length d. */
  components: number[][];
}

/** Iterations per component — the spectrum here is smooth, so this converges early. */
const POWER_ITERATIONS = 40;

/**
 * Fit the top `k` principal directions of `rows`.
 *
 * Must be fitted on training rows only. It never sees a target, but a projection
 * chosen with the held-out fold in hand still flatters the score it is then used
 * to produce — and this tool's numbers are only worth anything because nothing
 * is allowed to do that.
 */
export function fitPca(rows: number[][], k: number): PcaModel {
  const n = rows.length;
  if (n === 0) throw new Error('pca: empty training set');
  const d = rows[0]!.length;
  const want = Math.max(0, Math.min(k, Math.min(d, n)));

  const mean = new Float64Array(d);
  for (const row of rows) for (let j = 0; j < d; j++) mean[j]! += row[j]!;
  for (let j = 0; j < d; j++) mean[j]! /= n;
  const centered = rows.map((row) => Float64Array.from(row, (v, j) => v - mean[j]!));

  const components: number[][] = [];
  // Deterministic start vector: a fixed pseudo-random direction, so two runs on
  // one dataset produce the same profile.
  let seed = 0x9e3779b9;
  const next = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) - 0.5;
  };

  for (let c = 0; c < want; c++) {
    let v = Float64Array.from({ length: d }, next);
    let norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    if (norm < 1e-12) break;
    for (let j = 0; j < d; j++) v[j]! /= norm;

    for (let iteration = 0; iteration < POWER_ITERATIONS; iteration++) {
      // u = XᵀX v, accumulated without ever forming XᵀX.
      const u = new Float64Array(d);
      for (const x of centered) {
        let dot = 0;
        for (let j = 0; j < d; j++) dot += x[j]! * v[j]!;
        for (let j = 0; j < d; j++) u[j]! += dot * x[j]!;
      }
      // Deflate against the components already found, so this one is orthogonal.
      for (const previous of components) {
        let dot = 0;
        for (let j = 0; j < d; j++) dot += u[j]! * previous[j]!;
        for (let j = 0; j < d; j++) u[j]! -= dot * previous[j]!;
      }
      norm = Math.sqrt(u.reduce((s, x) => s + x * x, 0));
      if (norm < 1e-12) break;
      for (let j = 0; j < d; j++) u[j]! /= norm;
      v = u;
    }
    if (Math.sqrt(v.reduce((s, x) => s + x * x, 0)) < 0.5) break; // degenerate
    components.push(Array.from(v));
  }

  return { mean: Array.from(mean), components };
}

/** Project one vector onto the fitted directions. */
export function applyPca(vector: number[], model: PcaModel): number[] {
  return model.components.map((component) => {
    let sum = 0;
    for (let j = 0; j < vector.length; j++) sum += (vector[j]! - model.mean[j]!) * component[j]!;
    return sum;
  });
}
