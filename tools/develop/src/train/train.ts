/**
 * Training orchestration: a develop-export dataset → branched DevelopProfile.
 *
 * Edited photos are split by treatment (colour vs B&W, deterministic from the
 * edit), and ONE ridge model is trained per treatment over its shared+branch
 * parameters — so a high-contrast B&W edit and a light colour edit never average
 * into a mushy mean. Each model picks λ by k-fold CV and reports per-parameter
 * held-out MAE vs the "apply my average edit" baseline (the go/no-go metric).
 */
import {
  DEVELOP_PARAMS,
  SCHEMA_VERSION,
  decodeDelta,
  paramsForTreatment,
  type AsShotMeta,
  type DevelopParam,
  type Treatment,
} from '../develop/schema.js';
import { assembleFeatures, targetDeltas, actualAbsVec, profileOneHot } from '../develop/assemble.js';
import { buildNormalEquations, solveRidge, predictStd } from './regress.js';
import type { BranchModel, DevelopDataset, DevelopProfile, ParamEval } from '../types.js';

export interface TrainOptions {
  name: string;
  lambda?: number;
  folds?: number;
}

const LAMBDA_GRID = [100, 300, 1000, 3000, 10000, 30000];
const DEFAULT_FALLBACK_LAMBDA = 1000;
const EPS = 1e-6;

interface RawRow {
  embedding: number[];
  features: number[];
  develop: Record<string, number>;
  meta: AsShotMeta;
  treatment: Treatment;
  baseProfile?: string;
}

/** Base-profile vocabulary: profiles used on ≥3 of the branch's images. */
function buildProfileVocab(rows: RawRow[]): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) if (r.baseProfile) counts.set(r.baseProfile, (counts.get(r.baseProfile) ?? 0) + 1);
  return [...counts.entries()].filter(([, c]) => c >= 3).map(([k]) => k).sort();
}

interface BranchRow {
  x: number[];
  deltas: number[];
  abs: number[];
  meta: AsShotMeta;
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

/** B&W vs colour, from the explicit field or the edit structure (GrayMixer/flag). */
function deriveTreatment(r: { treatment?: Treatment; develop: Record<string, number> }): Treatment {
  if (r.treatment) return r.treatment;
  if (r.develop['ConvertToGrayscale'] === 1) return 'bw';
  if (Object.keys(r.develop).some((k) => k.startsWith('GrayMixer'))) return 'bw';
  return 'color';
}

function buildRows(dataset: DevelopDataset): RawRow[] {
  const rows: RawRow[] = [];
  for (const r of dataset.results) {
    if (!r.embedding?.length || !r.features?.length) continue;
    if (Object.keys(r.develop).length === 0) continue; // edited-only
    rows.push({
      embedding: r.embedding,
      features: r.features,
      develop: r.develop,
      meta: r.asShot,
      treatment: deriveTreatment(r),
      baseProfile: r.baseProfile,
    });
  }
  return rows;
}

function imageDependentSkill(perParam: ParamEval[]): number | null {
  let wsum = 0;
  let acc = 0;
  for (const p of perParam) {
    if (p.weight < 1.5) continue;
    if (p.baselineMae < EPS) continue;
    wsum += p.weight;
    acc += p.weight * p.skill;
  }
  return wsum > 0 ? Math.round((acc / wsum) * 1e4) / 1e4 : null;
}

/** k-fold CV over the λ grid at once → per-λ out-of-fold per-parameter eval. */
function crossValidate(rows: BranchRow[], params: DevelopParam[], grid: number[], folds: number): Map<number, ParamEval[]> {
  const P = params.length;
  const shuffledRows = shuffled(rows);
  const foldOf = shuffledRows.map((_, i) => i % folds);
  const modelErr = new Map<number, number[]>(grid.map((l) => [l, new Array<number>(P).fill(0)]));
  const baseErr = new Array<number>(P).fill(0);
  let counted = 0;

  for (let f = 0; f < folds; f++) {
    const train = shuffledRows.filter((_, i) => foldOf[i] !== f);
    const val = shuffledRows.filter((_, i) => foldOf[i] === f);
    if (train.length < 2 || val.length === 0) continue;
    const fs = columnStats(train.map((r) => r.x));
    const ds = columnStats(train.map((r) => r.deltas));
    const ne = buildNormalEquations(train.map((r) => standardize(r.x, fs)), train.map((r) => standardize(r.deltas, ds)));

    const baselineAbs = new Array<number>(P).fill(0);
    for (const r of train) for (let k = 0; k < P; k++) baselineAbs[k]! += r.abs[k]!;
    for (let k = 0; k < P; k++) baselineAbs[k]! /= train.length;
    for (const r of val) for (let k = 0; k < P; k++) baseErr[k]! += Math.abs(baselineAbs[k]! - r.abs[k]!);
    counted += val.length;

    for (const lambda of grid) {
      const { weights, bias } = solveRidge(ne, lambda);
      const err = modelErr.get(lambda)!;
      for (const r of val) {
        const predStd = predictStd(weights, bias, standardize(r.x, fs));
        for (let k = 0; k < P; k++) {
          const delta = predStd[k]! * ds.std[k]! + ds.mean[k]!;
          err[k]! += Math.abs(decodeDelta(params[k]!, delta, r.meta) - r.abs[k]!);
        }
      }
    }
  }

  const out = new Map<number, ParamEval[]>();
  const n = Math.max(1, counted);
  for (const lambda of grid) {
    const err = modelErr.get(lambda)!;
    out.set(lambda, params.map((param, k) => {
      const modelMae = err[k]! / n;
      const baselineMae = baseErr[k]! / n;
      return {
        key: param.key,
        group: param.group,
        branch: param.branch,
        weight: param.weight,
        modelMae: Math.round(modelMae * 1e4) / 1e4,
        baselineMae: Math.round(baselineMae * 1e4) / 1e4,
        skill: baselineMae > EPS ? Math.round((1 - modelMae / baselineMae) * 1e4) / 1e4 : 0,
      };
    }));
  }
  return out;
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/** Train one treatment's model over its shared+branch parameters. */
function trainBranch(raw: RawRow[], treatment: Treatment, options: TrainOptions): BranchModel {
  const params = paramsForTreatment(treatment);
  const folds = options.folds ?? 5;
  const profileVocab = buildProfileVocab(raw);
  const rows: BranchRow[] = raw.map((r) => ({
    x: [...assembleFeatures(r.embedding, r.features, r.meta), ...profileOneHot(r.baseProfile, profileVocab)],
    deltas: targetDeltas(params, r.develop, r.meta),
    abs: actualAbsVec(params, r.develop, r.meta),
    meta: r.meta,
  }));

  let perParam: ParamEval[] = [];
  let chosenLambda = options.lambda ?? DEFAULT_FALLBACK_LAMBDA;
  let heldOut = 0;
  if (rows.length >= folds * 4) {
    const grid = options.lambda !== undefined ? [options.lambda] : LAMBDA_GRID;
    const cv = crossValidate(rows, params, grid, folds);
    if (options.lambda === undefined) {
      let best = -Infinity;
      for (const [lambda, pp] of cv) {
        const s = imageDependentSkill(pp) ?? -Infinity;
        if (s > best) { best = s; chosenLambda = lambda; }
      }
    }
    perParam = cv.get(chosenLambda) ?? [];
    heldOut = rows.length;
  }

  const featStats = columnStats(rows.map((r) => r.x));
  const deltaStats = columnStats(rows.map((r) => r.deltas));
  const ne = buildNormalEquations(rows.map((r) => standardize(r.x, featStats)), rows.map((r) => standardize(r.deltas, deltaStats)));
  const { weights, bias } = solveRidge(ne, chosenLambda);

  return {
    treatment,
    params: params.map((p) => p.key),
    profileVocab,
    ridgeLambda: chosenLambda,
    featureMean: featStats.mean.map(round6),
    featureStd: featStats.std.map(round6),
    deltaMean: deltaStats.mean.map(round6),
    deltaStd: deltaStats.std.map(round6),
    weights: weights.map((w) => w.map(round6)),
    bias: bias.map(round6),
    samples: rows.length,
    heldOut,
    imageDependentSkill: imageDependentSkill(perParam),
    perParam,
  };
}

export function train(dataset: DevelopDataset, options: TrainOptions): DevelopProfile {
  const rows = buildRows(dataset);
  if (rows.length < 2) throw new Error(`too few edited images (${rows.length}); need embeddings + color features`);

  const byTreatment: Record<Treatment, RawRow[]> = { color: [], bw: [] };
  for (const r of rows) byTreatment[r.treatment].push(r);

  const branches: DevelopProfile['branches'] = {};
  for (const treatment of ['color', 'bw'] as const) {
    if (byTreatment[treatment].length >= 5) {
      branches[treatment] = trainBranch(byTreatment[treatment], treatment, options);
    }
  }
  if (Object.keys(branches).length === 0) {
    throw new Error('no treatment had enough edited images to train a model (need ≥5 per branch)');
  }

  const embeddingDim = dataset.dim || (dataset.results[0]?.embedding.length ?? 0);
  const colorDim = dataset.colorDim || (dataset.results[0]?.features.length ?? 0);

  return {
    name: options.name,
    description: `Branched develop profile: ${byTreatment.color.length} colour + ${byTreatment.bw.length} B&W edited images (baseline: ${dataset.baseline})`,
    type: 'develop-branched',
    schemaVersion: SCHEMA_VERSION,
    embeddingModel: dataset.model,
    embeddingDim,
    colorDim,
    colorFeatureNames: dataset.colorFeatureNames ?? [],
    baseline: dataset.baseline,
    branches,
    trainedAt: new Date().toISOString(),
    stats: { edited: rows.length, color: byTreatment.color.length, bw: byTreatment.bw.length },
  };
}

/** Re-export for callers that enumerate the schema (e.g. reporting). */
export { DEVELOP_PARAMS };
