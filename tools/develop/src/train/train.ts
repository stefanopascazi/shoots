/**
 * Training orchestration: a develop-export dataset → DevelopProfile.
 *
 * Pipeline: assemble features + target deltas → standardize both → multi-output
 * ridge. With only a few hundred edited photos against a ~560-dim feature space
 * the head overfits badly unless strongly regularized, so λ is chosen by **k-fold
 * cross-validation** (out-of-fold predictions over every sample — far more stable
 * than a single 20% split at this size). The reported per-parameter skill is the
 * held-out MAE against the "apply my average edit" baseline; the headline number
 * is the weighted skill over the *image-dependent* parameters.
 */
import { DEVELOP_PARAMS, PARAM_COUNT, SCHEMA_VERSION, decodeDelta, type AsShotMeta } from '../develop/schema.js';
import { assembleFeatures, targetDeltas, actualAbs } from '../develop/assemble.js';
import { buildNormalEquations, solveRidge, predictStd } from './regress.js';
import type { DevelopDataset, DevelopProfile, ParamEval } from '../types.js';

export interface TrainOptions {
  name: string;
  /** Explicit ridge strength, or undefined to auto-select by cross-validation. */
  lambda?: number;
  /** Number of CV folds for λ selection / evaluation. */
  folds?: number;
}

/** λ grid swept during auto-selection (p ≫ n needs strong regularization). */
const LAMBDA_GRID = [100, 300, 1000, 3000, 10000, 30000];
const DEFAULT_FALLBACK_LAMBDA = 3000;

/** A row reduced to what training needs. */
interface Row {
  x: number[];
  deltas: number[];
  abs: number[];
  meta: AsShotMeta;
  hasDevelop: boolean;
}

interface ColStats {
  mean: number[];
  std: number[];
}

const EPS = 1e-6;

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

/** Deterministic LCG shuffle so runs are reproducible. */
function shuffled<T>(items: T[], seed = 12345): T[] {
  const a = items.slice();
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (1103515245 * s + 12345) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function buildRows(dataset: DevelopDataset): Row[] {
  const rows: Row[] = [];
  for (const r of dataset.results) {
    if (!r.embedding?.length || !r.features?.length) continue;
    const meta = r.asShot;
    rows.push({
      x: assembleFeatures(r.embedding, r.features, meta),
      deltas: targetDeltas(r.develop, meta),
      abs: DEVELOP_PARAMS.map((_, i) => actualAbs(i, r.develop, meta)),
      meta,
      hasDevelop: Object.keys(r.develop).length > 0,
    });
  }
  return rows;
}

/** Weighted-mean skill over the image-dependent parameters (weight ≥ 1.5). */
function imageDependentSkill(perParam: ParamEval[]): number | null {
  let wsum = 0;
  let acc = 0;
  for (const p of perParam) {
    if (p.weight < 1.5) continue;
    if (p.baselineMae < EPS) continue; // baseline doesn't vary ⇒ no meaningful skill
    wsum += p.weight;
    acc += p.weight * p.skill;
  }
  return wsum > 0 ? Math.round((acc / wsum) * 1e4) / 1e4 : null;
}

/**
 * k-fold cross-validated evaluation for every λ in the grid at once. Returns,
 * per λ, the out-of-fold per-parameter MAE (model + baseline) accumulated over
 * all samples. Standardization is refit per training fold to avoid leakage.
 */
function crossValidate(rows: Row[], grid: number[], folds: number): Map<number, ParamEval[]> {
  const shuffledRows = shuffled(rows);
  const foldOf = shuffledRows.map((_, i) => i % folds);

  const modelErr = new Map<number, number[]>(grid.map((l) => [l, new Array<number>(PARAM_COUNT).fill(0)]));
  const baseErr = new Array<number>(PARAM_COUNT).fill(0);
  let counted = 0;

  for (let f = 0; f < folds; f++) {
    const train = shuffledRows.filter((_, i) => foldOf[i] !== f);
    const val = shuffledRows.filter((_, i) => foldOf[i] === f);
    if (train.length < 2 || val.length === 0) continue;

    const featStats = columnStats(train.map((r) => r.x));
    const deltaStats = columnStats(train.map((r) => r.deltas));
    const ne = buildNormalEquations(train.map((r) => standardize(r.x, featStats)), train.map((r) => standardize(r.deltas, deltaStats)));

    const baselineAbs = new Array<number>(PARAM_COUNT).fill(0);
    for (const r of train) for (let k = 0; k < PARAM_COUNT; k++) baselineAbs[k]! += r.abs[k]!;
    for (let k = 0; k < PARAM_COUNT; k++) baselineAbs[k]! /= train.length;

    // Baseline error (λ-independent).
    for (const r of val) for (let k = 0; k < PARAM_COUNT; k++) baseErr[k]! += Math.abs(baselineAbs[k]! - r.abs[k]!);
    counted += val.length;

    for (const lambda of grid) {
      const { weights, bias } = solveRidge(ne, lambda);
      const err = modelErr.get(lambda)!;
      for (const r of val) {
        const predStd = predictStd(weights, bias, standardize(r.x, featStats));
        for (let k = 0; k < PARAM_COUNT; k++) {
          const delta = predStd[k]! * deltaStats.std[k]! + deltaStats.mean[k]!;
          err[k]! += Math.abs(decodeDelta(DEVELOP_PARAMS[k]!, delta, r.meta) - r.abs[k]!);
        }
      }
    }
  }

  const out = new Map<number, ParamEval[]>();
  const n = Math.max(1, counted);
  for (const lambda of grid) {
    const err = modelErr.get(lambda)!;
    out.set(
      lambda,
      DEVELOP_PARAMS.map((param, k) => {
        const modelMae = err[k]! / n;
        const baselineMae = baseErr[k]! / n;
        const skill = baselineMae > EPS ? 1 - modelMae / baselineMae : 0;
        return {
          key: param.key,
          group: param.group,
          weight: param.weight,
          modelMae: Math.round(modelMae * 1e4) / 1e4,
          baselineMae: Math.round(baselineMae * 1e4) / 1e4,
          skill: Math.round(skill * 1e4) / 1e4,
        };
      }),
    );
  }
  return out;
}

export function train(dataset: DevelopDataset, options: TrainOptions): DevelopProfile {
  const rows = buildRows(dataset);
  if (rows.length < 2) throw new Error(`too few usable images (${rows.length}); need embeddings + color features`);
  const withDevelop = rows.filter((r) => r.hasDevelop).length;
  const folds = options.folds ?? 5;

  // λ selection + per-parameter evaluation via cross-validation.
  let perParam: ParamEval[] = [];
  let chosenLambda = options.lambda ?? DEFAULT_FALLBACK_LAMBDA;
  let heldOut = 0;
  const canCv = rows.length >= folds * 4;
  if (canCv) {
    const grid = options.lambda !== undefined ? [options.lambda] : LAMBDA_GRID;
    const cv = crossValidate(rows, grid, folds);
    if (options.lambda === undefined) {
      // Pick the λ with the best image-dependent skill.
      let best = -Infinity;
      for (const [lambda, pp] of cv) {
        const s = imageDependentSkill(pp) ?? -Infinity;
        if (s > best) { best = s; chosenLambda = lambda; }
      }
    }
    perParam = cv.get(chosenLambda) ?? [];
    heldOut = rows.length;
  }

  // Final model on ALL rows with the chosen λ.
  const featStats = columnStats(rows.map((r) => r.x));
  const deltaStats = columnStats(rows.map((r) => r.deltas));
  const ne = buildNormalEquations(rows.map((r) => standardize(r.x, featStats)), rows.map((r) => standardize(r.deltas, deltaStats)));
  const { weights, bias } = solveRidge(ne, chosenLambda);

  const embeddingDim = dataset.dim || (dataset.results[0]?.embedding.length ?? 0);
  const colorDim = dataset.colorDim || (dataset.results[0]?.features.length ?? 0);

  return {
    name: options.name,
    description: `Develop profile learned from ${withDevelop}/${rows.length} images with develop settings (baseline: ${dataset.baseline}, λ=${chosenLambda})`,
    type: 'develop-linear',
    schemaVersion: SCHEMA_VERSION,
    embeddingModel: dataset.model,
    embeddingDim,
    colorDim,
    colorFeatureNames: dataset.colorFeatureNames ?? [],
    baseline: dataset.baseline,
    ridgeLambda: chosenLambda,
    params: DEVELOP_PARAMS.map((p) => p.key),
    featureMean: featStats.mean.map((v) => Math.round(v * 1e6) / 1e6),
    featureStd: featStats.std.map((v) => Math.round(v * 1e6) / 1e6),
    deltaMean: deltaStats.mean.map((v) => Math.round(v * 1e6) / 1e6),
    deltaStd: deltaStats.std.map((v) => Math.round(v * 1e6) / 1e6),
    weights: weights.map((w) => w.map((v) => Math.round(v * 1e6) / 1e6)),
    bias: bias.map((v) => Math.round(v * 1e6) / 1e6),
    trainedAt: new Date().toISOString(),
    stats: {
      samples: rows.length,
      withDevelop,
      heldOut,
      imageDependentSkill: imageDependentSkill(perParam),
      perParam,
    },
  };
}
