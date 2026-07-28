/**
 * Style-clustering diagnostic — tests the "mixture of develop styles" hypothesis.
 *
 * A single linear head averages incompatible looks (e.g. high-contrast B&W vs
 * light pastel colour) into a mushy mean, so skill collapses on mixed catalogs.
 * This measures the upper bound of fixing that: cluster the develop settings into
 * k style groups (unsupervised), then compare the held-out prediction skill of
 *   - POOLED: one model for everything (what we ship today), vs
 *   - CLUSTERED: one model per style, with ORACLE cluster assignment.
 * Both measured as skill against the same global "apply my average edit" baseline.
 * If CLUSTERED ≫ POOLED, conditioning on style is the lever (plan Fase 5).
 *
 * Oracle routing (clustering uses the target) is intentional: it isolates the
 * *execution* gain from the separate *routing* problem (predicting the style from
 * content / a human pick), which this diagnostic does not attempt.
 */
import { DEVELOP_PARAMS, decodeDelta, type AsShotMeta } from '../develop/schema.js';
import { assembleFeatures, targetDeltas, actualAbsVec } from '../develop/assemble.js';
import { buildNormalEquations, solveRidge, predictStd } from '../train/regress.js';
import { kmeans } from './kmeans.js';
import type { DevelopDataset } from '../types.js';

const GRID = [300, 1000, 3000, 10000, 30000];
const EPS = 1e-6;
const PARAM_COUNT = DEVELOP_PARAMS.length;
/** Emphasize the B&W treatment in clustering — it is a dominant style axis. */
const BW_KEY = 'ConvertToGrayscale';
const BW_WEIGHT = 3;

interface DRow {
  x: number[];
  deltas: number[];
  abs: number[];
  meta: AsShotMeta;
  develop: Record<string, number>;
  curve?: number[];
}

/** Inputs (0..255) at which the tone curve is sampled for clustering features. */
const CURVE_SAMPLES = [0, 32, 64, 96, 128, 160, 192, 224, 255];
/** Contrast / black-clipping is a dominant style axis → weight the curve features. */
const CURVE_WEIGHT = 2.5;

/** Sample a point tone curve at fixed inputs → normalized outputs (linear default). */
function sampleCurve(curve: number[] | undefined): number[] {
  if (!curve || curve.length < 4) return CURVE_SAMPLES.map((x) => x / 255);
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < curve.length; i += 2) pts.push([curve[i]!, curve[i + 1]!]);
  pts.sort((a, b) => a[0] - b[0]);
  const interp = (x: number): number => {
    if (x <= pts[0]![0]) return pts[0]![1];
    if (x >= pts[pts.length - 1]![0]) return pts[pts.length - 1]![1];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, y0] = pts[i]!;
      const [x1, y1] = pts[i + 1]!;
      if (x >= x0 && x <= x1) return y0 + ((x - x0) / (x1 - x0 || 1)) * (y1 - y0);
    }
    return x;
  };
  return CURVE_SAMPLES.map((x) => interp(x) / 255);
}

interface ColStats { mean: number[]; std: number[]; }

function columnStats(rows: number[][]): ColStats {
  const n = rows.length;
  const d = rows[0]!.length;
  const mean = new Array<number>(d).fill(0);
  const std = new Array<number>(d).fill(0);
  for (const r of rows) for (let j = 0; j < d; j++) mean[j]! += r[j]!;
  for (let j = 0; j < d; j++) mean[j]! /= n;
  for (const r of rows) for (let j = 0; j < d; j++) { const dv = r[j]! - mean[j]!; std[j]! += dv * dv; }
  for (let j = 0; j < d; j++) std[j] = Math.max(EPS, Math.sqrt(std[j]! / n));
  return { mean, std };
}
const standardize = (row: number[], s: ColStats): number[] => row.map((v, j) => (v - s.mean[j]!) / s.std[j]!);

function shuffledIdx(n: number, seed = 12345): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  let s = seed >>> 0;
  for (let i = n - 1; i > 0; i--) {
    s = (1103515245 * s + 12345) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function buildRows(dataset: DevelopDataset): DRow[] {
  const rows: DRow[] = [];
  for (const r of dataset.results) {
    if (!r.embedding?.length || !r.features?.length) continue;
    if (Object.keys(r.develop).length === 0) continue; // edited only
    rows.push({
      x: assembleFeatures(r.embedding, r.features, r.asShot),
      deltas: targetDeltas(DEVELOP_PARAMS, r.develop, r.asShot),
      abs: actualAbsVec(DEVELOP_PARAMS, r.develop, r.asShot),
      meta: r.asShot,
      develop: r.develop,
      curve: r.curve,
    });
  }
  return rows;
}

/** Weighted image-dependent skill of predicted-abs vs a fixed baseline-abs. */
function imageDependentSkill(rows: DRow[], predAbs: number[][], baselineAbs: number[]): number | null {
  let wsum = 0;
  let acc = 0;
  for (let k = 0; k < PARAM_COUNT; k++) {
    const param = DEVELOP_PARAMS[k]!;
    if (param.weight < 1.5) continue;
    let modelErr = 0;
    let baseErr = 0;
    for (let i = 0; i < rows.length; i++) {
      modelErr += Math.abs(predAbs[i]![k]! - rows[i]!.abs[k]!);
      baseErr += Math.abs(baselineAbs[k]! - rows[i]!.abs[k]!);
    }
    if (baseErr < EPS) continue;
    const skill = 1 - modelErr / baseErr;
    wsum += param.weight;
    acc += param.weight * skill;
  }
  return wsum > 0 ? acc / wsum : null;
}

/** Out-of-fold predicted-abs for a set of rows (picks λ by image-dependent skill). */
function cvPredictAbs(rows: DRow[], folds: number): number[][] {
  const n = rows.length;
  const meanAbs = new Array<number>(PARAM_COUNT).fill(0);
  for (const r of rows) for (let k = 0; k < PARAM_COUNT; k++) meanAbs[k]! += r.abs[k]!;
  for (let k = 0; k < PARAM_COUNT; k++) meanAbs[k]! /= n;

  // Too small for a stable CV → fall back to the group mean (skill ≈ 0 vs it).
  if (n < folds * 3) return rows.map(() => meanAbs.slice());

  const order = shuffledIdx(n);
  const foldOf = new Array<number>(n);
  order.forEach((rowIdx, i) => { foldOf[rowIdx] = i % folds; });

  // Per-λ out-of-fold predictions.
  const predByLambda = new Map<number, number[][]>(GRID.map((l) => [l, Array.from({ length: n }, () => new Array<number>(PARAM_COUNT).fill(0))]));

  for (let f = 0; f < folds; f++) {
    const train = rows.filter((_, i) => foldOf[i] !== f);
    const valIdx = rows.map((_, i) => i).filter((i) => foldOf[i] === f);
    if (train.length < 2 || valIdx.length === 0) continue;
    const fs = columnStats(train.map((r) => r.x));
    const ds = columnStats(train.map((r) => r.deltas));
    const ne = buildNormalEquations(train.map((r) => standardize(r.x, fs)), train.map((r) => standardize(r.deltas, ds)));
    for (const lambda of GRID) {
      const { weights, bias } = solveRidge(ne, lambda);
      const out = predByLambda.get(lambda)!;
      for (const i of valIdx) {
        const predStd = predictStd(weights, bias, standardize(rows[i]!.x, fs));
        for (let k = 0; k < PARAM_COUNT; k++) {
          const delta = predStd[k]! * ds.std[k]! + ds.mean[k]!;
          out[i]![k] = decodeDelta(DEVELOP_PARAMS[k]!, delta, rows[i]!.meta);
        }
      }
    }
  }

  // Pick the λ with the best image-dependent skill (vs this set's mean).
  let bestLambda = GRID[0]!;
  let best = -Infinity;
  for (const lambda of GRID) {
    const s = imageDependentSkill(rows, predByLambda.get(lambda)!, meanAbs) ?? -Infinity;
    if (s > best) { best = s; bestLambda = lambda; }
  }
  return predByLambda.get(bestLambda)!;
}

export interface ClusterSignature {
  size: number;
  bwFraction: number | null;
  meanSaturation: number;
  meanContrast: number;
  meanHighlights: number;
  meanExposure: number;
  /** Mean tone-curve output at input 0 (0..1): high = lifted/matte blacks. */
  blackLift: number;
  /** Mean curve contrast (output@192 − output@64): high = steep/contrasty. */
  curveContrast: number;
}

export interface DiagnoseResult {
  edited: number;
  pooledSkill: number | null;
  perK: { k: number; clusteredSkill: number | null; clusters: ClusterSignature[] }[];
}

/**
 * Build the clustering feature vectors: standardized absolute develop values
 * PLUS the sampled tone curve (the contrast / black-clipping style axis, which the
 * slider params alone miss). B&W and curve axes are up-weighted.
 */
function clusterVectors(rows: DRow[]): number[][] {
  // Union of develop keys present in ≥10% of edited rows.
  const counts = new Map<string, number>();
  for (const r of rows) for (const k of Object.keys(r.develop)) counts.set(k, (counts.get(k) ?? 0) + 1);
  const keys = [...counts.entries()].filter(([, c]) => c >= rows.length * 0.1).map(([k]) => k);
  const nKeys = keys.length;
  const raw = rows.map((r) => [...keys.map((k) => r.develop[k] ?? 0), ...sampleCurve(r.curve)]);
  const s = columnStats(raw);
  return raw.map((row) => row.map((v, j) => {
    const z = (v - s.mean[j]!) / s.std[j]!;
    if (j >= nKeys) return z * CURVE_WEIGHT; // curve-sample columns
    return keys[j] === BW_KEY ? z * BW_WEIGHT : z;
  }));
}

function signature(rows: DRow[], idx: number[]): ClusterSignature {
  const get = (key: string): number => idx.reduce((a, i) => a + (rows[i]!.develop[key] ?? 0), 0) / idx.length;
  const bwPresent = rows.some((r) => BW_KEY in r.develop);
  // Curve-derived: black lift (output@0) and contrast (output@192 − output@64).
  let blackLift = 0;
  let curveContrast = 0;
  for (const i of idx) {
    const s = sampleCurve(rows[i]!.curve); // aligned with CURVE_SAMPLES
    blackLift += s[0]!;
    curveContrast += s[6]! - s[2]!;
  }
  return {
    size: idx.length,
    bwFraction: bwPresent ? get(BW_KEY) : null,
    meanSaturation: Math.round(get('Saturation')),
    meanContrast: Math.round(get('Contrast2012')),
    meanHighlights: Math.round(get('Highlights2012')),
    meanExposure: Math.round(get('Exposure2012') * 100) / 100,
    blackLift: Math.round((blackLift / idx.length) * 1000) / 1000,
    curveContrast: Math.round((curveContrast / idx.length) * 1000) / 1000,
  };
}

export function diagnose(dataset: DevelopDataset, opts: { folds?: number; maxK?: number } = {}): DiagnoseResult {
  const folds = opts.folds ?? 5;
  const maxK = opts.maxK ?? 4;
  const rows = buildRows(dataset);
  if (rows.length < folds * 3) throw new Error(`too few edited images (${rows.length}) for the diagnostic`);

  const baselineAbs = new Array<number>(PARAM_COUNT).fill(0);
  for (const r of rows) for (let k = 0; k < PARAM_COUNT; k++) baselineAbs[k]! += r.abs[k]!;
  for (let k = 0; k < PARAM_COUNT; k++) baselineAbs[k]! /= rows.length;

  const pooledSkill = imageDependentSkill(rows, cvPredictAbs(rows, folds), baselineAbs);

  const cvecs = clusterVectors(rows);
  const perK: DiagnoseResult['perK'] = [];
  for (let k = 2; k <= maxK; k++) {
    const { assign } = kmeans(cvecs, k);
    const clusteredPred = Array.from({ length: rows.length }, () => new Array<number>(PARAM_COUNT).fill(0));
    const clusters: ClusterSignature[] = [];
    for (let c = 0; c < k; c++) {
      const idx = rows.map((_, i) => i).filter((i) => assign[i] === c);
      if (idx.length === 0) continue;
      const pred = cvPredictAbs(idx.map((i) => rows[i]!), folds);
      idx.forEach((i, j) => { clusteredPred[i] = pred[j]!; });
      clusters.push(signature(rows, idx));
    }
    clusters.sort((a, b) => b.size - a.size);
    perK.push({ k, clusteredSkill: imageDependentSkill(rows, clusteredPred, baselineAbs), clusters });
  }

  return { edited: rows.length, pooledSkill, perK };
}
