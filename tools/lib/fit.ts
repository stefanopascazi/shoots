/**
 * Small fitting primitives shared by the research tools in `tools/`.
 *
 * Deliberately separate from `packages/cli/src/develop/train`: that code carries
 * the shipped model's conventions (delta space, two heads, de-shrinking), and a
 * research tool that quietly inherited them would answer a different question
 * than the one it was pointed at. Only the ridge solver itself is reused.
 */
import { buildNormalEquations, solveRidge } from '../../packages/cli/src/develop/train/regress.js';

export interface ColStats {
  mean: number[];
  std: number[];
}

export function columnStats(rows: number[][]): ColStats {
  const d = rows[0]?.length ?? 0;
  const mean = new Array<number>(d).fill(0);
  for (const r of rows) for (let j = 0; j < d; j++) mean[j]! += r[j]!;
  for (let j = 0; j < d; j++) mean[j]! /= Math.max(1, rows.length);
  const std = new Array<number>(d).fill(0);
  for (const r of rows) for (let j = 0; j < d; j++) std[j]! += (r[j]! - mean[j]!) ** 2;
  // A constant column would divide by zero; 1 leaves it constant, and centering
  // in the normal equations then kills it.
  for (let j = 0; j < d; j++) std[j]! = Math.sqrt(std[j]! / Math.max(1, rows.length)) || 1;
  return { mean, std };
}

export const standardize = (x: number[], s: ColStats): number[] => x.map((v, j) => (v - s.mean[j]!) / s.std[j]!);

/** A fitted single-target ridge that carries its own standardization. */
export interface Fitted {
  predict(x: number[]): number;
  /** Mean of the training target — the constant this model has to beat. */
  ybar: number;
  /** Weights over the *standardized* columns. */
  coef: number[];
  /** Intercept in the standardized target space. */
  bias: number;
  /** Column mean/std the inputs are standardized by. */
  stats: ColStats;
  /** Target sd the standardized prediction is scaled back up by. */
  yspread: number;
}

/** Ridge on raw (unstandardized) inputs; standardization is internal. */
export function fitRidge(X: number[][], y: number[], lambda: number): Fitted {
  const fx = columnStats(X);
  const ybar = y.reduce((a, b) => a + b, 0) / y.length;
  const yspread = Math.sqrt(y.reduce((a, v) => a + (v - ybar) ** 2, 0) / y.length) || 1;
  const fit = solveRidge(
    buildNormalEquations(X.map((x) => standardize(x, fx)), y.map((v) => [(v - ybar) / yspread])),
    lambda,
  );
  const w = fit.weights[0]!;
  const b = fit.bias[0]!;
  return {
    ybar,
    coef: w,
    bias: b,
    stats: fx,
    yspread,
    predict(x: number[]): number {
      const xs = standardize(x, fx);
      let dot = b;
      for (let j = 0; j < xs.length; j++) dot += w[j]! * xs[j]!;
      return dot * yspread + ybar;
    },
  };
}

/** Deterministic Fisher–Yates, so a re-run reproduces the same fold assignment. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  let s = (seed * 7919 + 13) >>> 0;
  const rnd = (): number => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Group-wise fold assignment: every member of a group lands in the same fold. */
export function foldsByGroup(groups: readonly string[], folds: number, seed: number): Map<string, number> {
  return new Map(shuffled([...new Set(groups)], seed).map((g, i) => [g, i % folds]));
}

export const mean = (a: readonly number[]): number => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);

export const sd = (a: readonly number[]): number => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((v) => (v - m) ** 2)));
};

/** Pearson correlation, for diagnosis alongside the skill number. */
export function correlation(a: readonly number[], b: readonly number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}
