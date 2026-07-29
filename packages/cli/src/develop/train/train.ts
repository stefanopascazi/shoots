/**
 * Training orchestration: a develop-export dataset → branched DevelopProfile.
 *
 * Edited photos are split by treatment (colour vs B&W, deterministic from the
 * edit), and ONE ridge model is trained per treatment over its shared+branch
 * parameters — so a high-contrast B&W edit and a light colour edit never average
 * into a mushy mean. Each model picks λ *per parameter* by k-fold CV and reports
 * per-parameter held-out MAE vs the "apply my average edit" baseline (the go/no-go
 * metric).
 *
 * The evaluation itself lives in `evaluate.ts` — sessions held out, baseline in
 * delta space — and is shared with `diagnose` so the two cannot disagree about
 * what skill means.
 *
 * Parameters the held-out evidence says the model cannot predict are *gated*:
 * the profile keeps predicting the photographer's constant for them rather than
 * a model output that measurably makes the result worse. Shipping a negative-
 * skill prediction is strictly worse than shipping no prediction at all.
 */
import {
  DEVELOP_PARAMS,
  SCHEMA_VERSION,
  paramsForTreatment,
  treatmentFromDevelop,
  type AsShotMeta,
  type Treatment,
} from '../develop/schema.js';
import { assembleFeatures, targetDeltas, actualAbsVec, profileOneHot } from '../develop/assemble.js';
import { buildNormalEquations, solveRidge } from './regress.js';
import {
  EPS,
  LAMBDA_GRID,
  columnStats,
  degenerateTargets,
  evaluateWithLambda,
  nestedEvaluate,
  selectLambdas,
  sessionKey,
  standardize,
  weightedSkill,
  type EvalRow,
  type GroupBy,
  type ParamStats,
} from './evaluate.js';
import type { BranchModel, DevelopDataset, DevelopProfile, ParamEval } from '../types.js';

export interface TrainOptions {
  name: string;
  lambda?: number;
  folds?: number;
  /** Fold policy for the gate metric (default: hold whole sessions out). */
  groupBy?: GroupBy;
  /** Skill at or below which a parameter falls back to the constant. 0 = off. */
  gateThreshold?: number;
}

const DEFAULT_FALLBACK_LAMBDA = 1000;
const DEFAULT_GATE_THRESHOLD = 0.02;

interface RawRow {
  file: string;
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

/** B&W vs colour, from the explicit field or the edit structure. */
function deriveTreatment(r: { treatment?: Treatment; develop: Record<string, number> }): Treatment {
  return r.treatment ?? treatmentFromDevelop(r.develop);
}

function buildRows(dataset: DevelopDataset): RawRow[] {
  const rows: RawRow[] = [];
  for (const r of dataset.results) {
    if (!r.embedding?.length || !r.features?.length) continue;
    if (Object.keys(r.develop).length === 0) continue; // edited-only
    rows.push({
      file: r.file,
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

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/** Train one treatment's model over its shared+branch parameters. */
function trainBranch(raw: RawRow[], treatment: Treatment, options: TrainOptions): BranchModel {
  const params = paramsForTreatment(treatment);
  const folds = options.folds ?? 5;
  const groupBy: GroupBy = options.groupBy ?? 'folder';
  const gateThreshold = options.gateThreshold ?? DEFAULT_GATE_THRESHOLD;
  const profileVocab = buildProfileVocab(raw);

  const rows: EvalRow[] = raw.map((r) => ({
    x: [...assembleFeatures(r.embedding, r.features, r.meta), ...profileOneHot(r.baseProfile, profileVocab)],
    deltas: targetDeltas(params, r.develop, r.meta),
    abs: actualAbsVec(params, r.develop, r.meta),
    meta: r.meta,
    group: sessionKey(r.file),
  }));

  const degenerate = degenerateTargets(rows, params.length);

  let gateStats: ParamStats[] = [];
  let randomStats: ParamStats[] = [];
  // λ per parameter. A fixed --lambda applies to all of them; otherwise each one
  // gets the shrinkage its own held-out evidence asks for.
  let lambdas = params.map(() => options.lambda ?? DEFAULT_FALLBACK_LAMBDA);
  let heldOut = 0;

  if (rows.length >= folds * 4) {
    if (options.lambda === undefined) {
      lambdas = selectLambdas(rows, params, { folds, groupBy, grid: LAMBDA_GRID });
      // The gate has to pay for that search: λ is re-chosen inside each outer
      // fold, so no parameter is scored on the split that picked its λ.
      gateStats = nestedEvaluate(rows, params, { folds, groupBy, grid: LAMBDA_GRID });
    } else {
      gateStats = evaluateWithLambda(rows, params, { folds, groupBy }, lambdas);
    }
    // The leakage-prone split, at the same λ, purely for contrast in the report.
    randomStats = evaluateWithLambda(rows, params, { folds, groupBy: 'none' }, lambdas);
    heldOut = rows.length;
  }

  const perParam: ParamEval[] = params.map((param, k) => {
    const gate = gateStats[k];
    const rand = randomStats[k];
    const isDegenerate = degenerate[k]!;
    // No held-out evidence at all (too few images) means no basis to trust a
    // prediction — but also none to condemn it, so only degeneracy gates here.
    const gated = isDegenerate || (gate !== undefined && gateThreshold > 0 && gate.skill <= gateThreshold);
    return {
      key: param.key,
      group: param.group,
      branch: param.branch,
      weight: param.weight,
      lambda: lambdas[k]!,
      modelMae: round4(gate?.modelMae ?? 0),
      baselineMae: round4(gate?.baselineMae ?? 0),
      skill: round4(gate?.skill ?? 0),
      skillRandom: round4(rand?.skill ?? 0),
      degenerate: isDegenerate,
      gated,
      ...(gated ? { gateReason: isDegenerate ? ('degenerate' as const) : ('low-skill' as const) } : {}),
    };
  });

  const featStats = columnStats(rows.map((r) => r.x));
  const deltaStats = columnStats(rows.map((r) => r.deltas));
  const ne = buildNormalEquations(rows.map((r) => standardize(r.x, featStats)), rows.map((r) => standardize(r.deltas, deltaStats)));
  // The normal equations are shared across λ, so each parameter can take its own
  // row out of the solution fitted at its own shrinkage for one Cholesky per
  // distinct λ — never one per parameter.
  const solved = new Map(([...new Set(lambdas)]).map((lambda) => [lambda, solveRidge(ne, lambda)]));
  const weights = params.map((_, k) => solved.get(lambdas[k]!)!.weights[k]!);
  const bias = params.map((_, k) => solved.get(lambdas[k]!)!.bias[k]!);

  const skillOf = (stats: ParamStats[]): number | null =>
    stats.length > 0 ? round4(weightedSkill(stats, params, degenerate) ?? 0) : null;

  return {
    treatment,
    params: params.map((p) => p.key),
    profileVocab,
    paramLambda: lambdas,
    featureMean: featStats.mean.map(round6),
    featureStd: featStats.std.map(round6),
    deltaMean: deltaStats.mean.map(round6),
    deltaStd: deltaStats.std.map(round6),
    weights: weights.map((w) => w.map(round6)),
    bias: bias.map(round6),
    samples: rows.length,
    heldOut,
    imageDependentSkill: gateStats.length > 0 ? skillOf(gateStats) : null,
    imageDependentSkillRandom: randomStats.length > 0 ? skillOf(randomStats) : null,
    gatedParams: perParam.filter((p) => p.gated).map((p) => p.key),
    gateThreshold,
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
export { DEVELOP_PARAMS, EPS };
