/**
 * Stage 2 — a linear head that generalizes to unseen photos.
 *
 * Bradley-Terry only scores photos that were duelled. To vote on photos that
 * were NEVER shown, we regress the latent θ onto the CLIP embedding:
 * s(x) = w·x + b, fit by ridge (L2) regression. `w` then scores any embedding in
 * the same CLIP space — the whole point of the exercise.
 */
import { solveSPD, dot } from './linalg.js';

export interface RidgeResult {
  weights: number[];
  bias: number;
}

/**
 * Ridge: minimize ‖Xc·w − yc‖² + λ‖w‖² on centered data, then recover the bias
 * from the means. Centering handles the intercept without penalizing it.
 */
export function fitRidge(X: Float32Array[], y: number[], lambda: number): RidgeResult {
  const n = X.length;
  if (n === 0) throw new Error('ridge: empty training set');
  const d = X[0]!.length;

  // Feature and target means.
  const xbar = new Float64Array(d);
  for (const row of X) for (let j = 0; j < d; j++) xbar[j]! += row[j]!;
  for (let j = 0; j < d; j++) xbar[j]! /= n;
  const ybar = y.reduce((a, b) => a + b, 0) / n;

  // Normal-equation matrix A = XcᵀXc + λI and rhs = Xcᵀ·yc.
  const A: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  const rhs = new Array<number>(d).fill(0);
  for (let i = 0; i < n; i++) {
    const row = X[i]!;
    const yc = y[i]! - ybar;
    for (let a = 0; a < d; a++) {
      const xa = row[a]! - xbar[a]!;
      rhs[a]! += xa * yc;
      const Aa = A[a]!;
      for (let b = a; b < d; b++) {
        Aa[b]! += xa * (row[b]! - xbar[b]!);
      }
    }
  }
  // Mirror upper→lower and add ridge penalty on the diagonal.
  for (let a = 0; a < d; a++) {
    A[a]![a]! += lambda;
    for (let b = a + 1; b < d; b++) A[b]![a]! = A[a]![b]!;
  }

  const weights = solveSPD(A, rhs);
  const bias = ybar - dot(weights, Array.from(xbar));
  return { weights, bias };
}

export function scoreOne(weights: number[], bias: number, x: ArrayLike<number>): number {
  return dot(weights, x) + bias;
}
