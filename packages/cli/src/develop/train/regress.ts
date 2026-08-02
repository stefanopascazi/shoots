/**
 * Multi-output ridge over the develop-setting deltas.
 *
 * Each of the P parameters is its own ridge regression s_p(x) = w_p·x + b_p, but
 * they all share the normal-equation matrix A = XcᵀXc + λI (it depends only on
 * the features, not on which parameter we predict). We build the centered
 * cross-products ONCE per training set, then — for each candidate λ — only add
 * λ to the diagonal and Cholesky-factor. That makes a λ sweep / k-fold CV cheap.
 *
 * Inputs are expected already standardized (zero-ish mean, unit-ish variance)
 * per column; centering here only cleans up residual offsets.
 */
import { choleskyFactor, solveCholesky, dot } from '../math/linalg.js';

export interface MultiRidgeResult {
  /** P rows × D cols. */
  weights: number[][];
  bias: number[];
}

/** Centered normal equations, reusable across λ values for the same data. */
export interface NormalEquations {
  /** XcᵀXc (symmetric, both triangles filled), d×d. */
  xtx: number[][];
  /** Xcᵀ·Yc per parameter, p×d. */
  rhs: Float64Array[];
  xbar: number[];
  ybar: number[];
  d: number;
  p: number;
  /**
   * Σ of the sample weights — the effective sample size λ is scaled against.
   *
   * XᵀX grows with n, so a bare `+λI` means a fixed λ shrinks a 400-image catalog
   * four times harder than a 1600-image one. That is not a knob anybody can reason
   * about, and it is how the grid ended up topping out at values that annihilated
   * every weight: at n=428 the old λ=30000 left 1.4% of the least-squares fit
   * standing, so the model emitted the photographer's mean for every photograph.
   * Scaling by Σw makes λ the shrinkage *per sample* — 1/(1+λ) of a standardized
   * column's coefficient — which means the same thing on every catalog.
   */
  sw: number;
}

/**
 * @param weights Per-sample importance, or omitted for the unweighted fit.
 *
 * Weighted least squares, and nothing more exotic: every cross-product is scaled
 * by the sample's weight, which is the same as fitting on a set where that
 * photograph appears `w` times. λ then shrinks against Σw rather than n — the
 * weights this tool produces are normalized around 1, so the effective sample
 * size stays close to the real one and the λ grid keeps meaning what it meant.
 */
export function buildNormalEquations(X: number[][], Y: number[][], weights?: readonly number[]): NormalEquations {
  const n = X.length;
  if (n === 0) throw new Error('ridge: empty training set');
  const d = X[0]!.length;
  const p = Y[0]!.length;
  const w = (i: number): number => weights?.[i] ?? 1;
  let sw = 0;
  for (let i = 0; i < n; i++) sw += w(i);
  if (sw <= 0) throw new Error('ridge: training weights sum to zero');

  const xbar = new Float64Array(d);
  for (let i = 0; i < n; i++) {
    const row = X[i]!;
    const wi = w(i);
    for (let j = 0; j < d; j++) xbar[j]! += wi * row[j]!;
  }
  for (let j = 0; j < d; j++) xbar[j]! /= sw;
  const ybar = new Float64Array(p);
  for (let i = 0; i < n; i++) {
    const row = Y[i]!;
    const wi = w(i);
    for (let k = 0; k < p; k++) ybar[k]! += wi * row[k]!;
  }
  for (let k = 0; k < p; k++) ybar[k]! /= sw;

  const xtx: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  const rhs: Float64Array[] = Array.from({ length: p }, () => new Float64Array(d));
  const xc = new Float64Array(d);
  for (let i = 0; i < n; i++) {
    const xr = X[i]!;
    const yr = Y[i]!;
    const wi = w(i);
    for (let a = 0; a < d; a++) xc[a] = xr[a]! - xbar[a]!;
    for (let a = 0; a < d; a++) {
      const xa = wi * xc[a]!;
      const Aa = xtx[a]!;
      for (let b = a; b < d; b++) Aa[b]! += xa * xc[b]!;
    }
    for (let k = 0; k < p; k++) {
      const yc = wi * (yr[k]! - ybar[k]!);
      const rk = rhs[k]!;
      for (let a = 0; a < d; a++) rk[a]! += xc[a]! * yc;
    }
  }
  // Mirror the upper triangle into the lower one.
  for (let a = 0; a < d; a++) for (let b = a + 1; b < d; b++) xtx[b]![a]! = xtx[a]![b]!;

  return { xtx, rhs, xbar: Array.from(xbar), ybar: Array.from(ybar), d, p, sw };
}

/** Solve the ridge head for a given λ, reusing prebuilt normal equations. */
export function solveRidge(ne: NormalEquations, lambda: number): MultiRidgeResult {
  const { xtx, rhs, xbar, ybar, d, p, sw } = ne;
  // A = XtX + λ·Σw·I (copy so ne stays reusable across λ). See NormalEquations.sw
  // for why the effective sample size belongs in there.
  const A: number[][] = xtx.map((row) => row.slice());
  for (let a = 0; a < d; a++) A[a]![a]! += lambda * sw;
  const L = choleskyFactor(A);

  const weights: number[][] = [];
  const bias: number[] = [];
  for (let k = 0; k < p; k++) {
    const w = solveCholesky(L, Array.from(rhs[k]!));
    weights.push(w);
    bias.push(ybar[k]! - dot(w, xbar));
  }
  return { weights, bias };
}

export function fitMultiRidge(X: number[][], Y: number[][], lambda: number, weights?: readonly number[]): MultiRidgeResult {
  return solveRidge(buildNormalEquations(X, Y, weights), lambda);
}

/** Predict the P standardized outputs for one standardized feature vector. */
export function predictStd(weights: number[][], bias: number[], xStd: number[]): number[] {
  return weights.map((w, k) => dot(w, xStd) + bias[k]!);
}
