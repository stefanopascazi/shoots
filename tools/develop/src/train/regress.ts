/**
 * Multi-output ridge over the develop-setting deltas.
 *
 * Each of the P parameters is its own ridge regression s_p(x) = w_p·x + b_p, but
 * they all share the normal-equation matrix A = XcᵀXc + λI. We build and
 * Cholesky-factor A once, then solve one right-hand side per parameter. Inputs
 * are expected already standardized (zero-ish mean, unit-ish variance) per
 * column; centering here only cleans up residual offsets.
 */
import { choleskyFactor, solveCholesky, dot } from '../math/linalg.js';

export interface MultiRidgeResult {
  /** P rows × D cols. */
  weights: number[][];
  bias: number[];
}

export function fitMultiRidge(X: number[][], Y: number[][], lambda: number): MultiRidgeResult {
  const n = X.length;
  if (n === 0) throw new Error('ridge: empty training set');
  const d = X[0]!.length;
  const p = Y[0]!.length;

  const xbar = new Float64Array(d);
  for (const row of X) for (let j = 0; j < d; j++) xbar[j]! += row[j]!;
  for (let j = 0; j < d; j++) xbar[j]! /= n;

  const ybar = new Float64Array(p);
  for (const row of Y) for (let k = 0; k < p; k++) ybar[k]! += row[k]!;
  for (let k = 0; k < p; k++) ybar[k]! /= n;

  // A = XcᵀXc + λI (upper triangle), rhs[k] = Xcᵀ·Yc[:,k].
  const A: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  const rhs: Float64Array[] = Array.from({ length: p }, () => new Float64Array(d));
  const xc = new Float64Array(d);
  for (let i = 0; i < n; i++) {
    const xr = X[i]!;
    const yr = Y[i]!;
    for (let a = 0; a < d; a++) xc[a] = xr[a]! - xbar[a]!;
    for (let a = 0; a < d; a++) {
      const xa = xc[a]!;
      const Aa = A[a]!;
      for (let b = a; b < d; b++) Aa[b]! += xa * xc[b]!;
    }
    for (let k = 0; k < p; k++) {
      const yc = yr[k]! - ybar[k]!;
      const rk = rhs[k]!;
      for (let a = 0; a < d; a++) rk[a]! += xc[a]! * yc;
    }
  }
  for (let a = 0; a < d; a++) {
    A[a]![a]! += lambda;
    for (let b = a + 1; b < d; b++) A[b]![a]! = A[a]![b]!;
  }

  const L = choleskyFactor(A);
  const weights: number[][] = [];
  const bias: number[] = [];
  const xbarArr = Array.from(xbar);
  for (let k = 0; k < p; k++) {
    const w = solveCholesky(L, Array.from(rhs[k]!));
    weights.push(w);
    bias.push(ybar[k]! - dot(w, xbarArr));
  }
  return { weights, bias };
}

/** Predict the P standardized outputs for one standardized feature vector. */
export function predictStd(weights: number[][], bias: number[], xStd: number[]): number[] {
  return weights.map((w, k) => dot(w, xStd) + bias[k]!);
}
