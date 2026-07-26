/**
 * Training orchestration: a develop-export dataset → DevelopProfile.
 *
 * Pipeline: assemble features + target deltas → standardize both → multi-output
 * ridge (Stage: the head) → held-out per-parameter MAE against the "apply my
 * average edit" baseline (the plan's go/no-go evidence). The headline number is
 * the weighted skill over the *image-dependent* parameters — style constants are
 * expected to collapse to the mean and must not flatter the aggregate.
 */
import { DEVELOP_PARAMS, PARAM_COUNT, SCHEMA_VERSION, decodeDelta, type AsShotMeta } from '../develop/schema.js';
import { assembleFeatures, targetDeltas, actualAbs } from '../develop/assemble.js';
import { fitMultiRidge, predictStd } from './regress.js';
import type { DevelopDataset, DevelopProfile, ParamEval } from '../types.js';

export interface TrainOptions {
  name: string;
  lambda?: number;
  /** Fraction of images held out to measure per-parameter generalization. */
  holdout?: number;
}

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

/** Fit on a training split and report per-parameter held-out MAE vs the mean baseline. */
function evaluate(train: Row[], test: Row[], lambda: number): ParamEval[] {
  const featStats = columnStats(train.map((r) => r.x));
  const deltaStats = columnStats(train.map((r) => r.deltas));
  const Xstd = train.map((r) => standardize(r.x, featStats));
  const Ystd = train.map((r) => standardize(r.deltas, deltaStats));
  const { weights, bias } = fitMultiRidge(Xstd, Ystd, lambda);

  // Baseline = mean absolute develop value over the train split (per param).
  const baselineAbs = new Array<number>(PARAM_COUNT).fill(0);
  for (const r of train) for (let k = 0; k < PARAM_COUNT; k++) baselineAbs[k]! += r.abs[k]!;
  for (let k = 0; k < PARAM_COUNT; k++) baselineAbs[k]! /= train.length;

  const modelErr = new Array<number>(PARAM_COUNT).fill(0);
  const baseErr = new Array<number>(PARAM_COUNT).fill(0);
  for (const r of test) {
    const predStd = predictStd(weights, bias, standardize(r.x, featStats));
    for (let k = 0; k < PARAM_COUNT; k++) {
      const delta = predStd[k]! * deltaStats.std[k]! + deltaStats.mean[k]!;
      const predAbs = decodeDelta(DEVELOP_PARAMS[k]!, delta, r.meta);
      modelErr[k]! += Math.abs(predAbs - r.abs[k]!);
      baseErr[k]! += Math.abs(baselineAbs[k]! - r.abs[k]!);
    }
  }

  return DEVELOP_PARAMS.map((param, k) => {
    const modelMae = modelErr[k]! / test.length;
    const baselineMae = baseErr[k]! / test.length;
    const skill = baselineMae > EPS ? 1 - modelMae / baselineMae : 0;
    return {
      key: param.key,
      group: param.group,
      weight: param.weight,
      modelMae: Math.round(modelMae * 1e4) / 1e4,
      baselineMae: Math.round(baselineMae * 1e4) / 1e4,
      skill: Math.round(skill * 1e4) / 1e4,
    };
  });
}

/** Weighted-mean skill over the image-dependent parameters (weight ≥ 1.5). */
function imageDependentSkill(perParam: ParamEval[]): number | null {
  let wsum = 0;
  let acc = 0;
  for (const p of perParam) {
    if (p.weight < 1.5) continue;
    // Only params whose baseline actually varies carry a meaningful skill.
    if (p.baselineMae < EPS) continue;
    wsum += p.weight;
    acc += p.weight * p.skill;
  }
  return wsum > 0 ? Math.round((acc / wsum) * 1e4) / 1e4 : null;
}

export function train(dataset: DevelopDataset, options: TrainOptions): DevelopProfile {
  const lambda = options.lambda ?? 10;
  const rows = buildRows(dataset);
  if (rows.length < 2) throw new Error(`too few usable images (${rows.length}); need embeddings + color features`);
  const withDevelop = rows.filter((r) => r.hasDevelop).length;

  // Final model on ALL rows.
  const featStats = columnStats(rows.map((r) => r.x));
  const deltaStats = columnStats(rows.map((r) => r.deltas));
  const Xstd = rows.map((r) => standardize(r.x, featStats));
  const Ystd = rows.map((r) => standardize(r.deltas, deltaStats));
  const { weights, bias } = fitMultiRidge(Xstd, Ystd, lambda);

  // Held-out evaluation (needs enough data to be meaningful).
  const holdout = options.holdout ?? 0.2;
  const all = shuffled(rows);
  const testSize = Math.floor(all.length * holdout);
  let perParam: ParamEval[] = [];
  let heldOut = 0;
  if (testSize >= 5 && all.length - testSize >= 10) {
    const test = all.slice(0, testSize);
    const trainSplit = all.slice(testSize);
    perParam = evaluate(trainSplit, test, lambda);
    heldOut = test.length;
  }

  const embeddingDim = dataset.dim || (dataset.results[0]?.embedding.length ?? 0);
  const colorDim = dataset.colorDim || (dataset.results[0]?.features.length ?? 0);

  return {
    name: options.name,
    description: `Develop profile learned from ${withDevelop}/${rows.length} images with develop settings (baseline: ${dataset.baseline})`,
    type: 'develop-linear',
    schemaVersion: SCHEMA_VERSION,
    embeddingModel: dataset.model,
    embeddingDim,
    colorDim,
    colorFeatureNames: dataset.colorFeatureNames ?? [],
    baseline: dataset.baseline,
    ridgeLambda: lambda,
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
