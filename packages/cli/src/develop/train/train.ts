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
  renderKey,
  treatmentFromDevelop,
  withCurveTargets,
  type AsShotMeta,
  type RenderProfile,
  type Treatment,
} from '../develop/schema.js';
import { assembleFeatures, targetDeltas, actualAbsVec, renderOneHot } from '../develop/assemble.js';
import { buildSessionContext, contextFor, sessionKey } from '../develop/session.js';
import { buildNormalEquations, solveRidge } from './regress.js';
import { fitPca, applyPca } from './pca.js';
import {
  EPS,
  LAMBDA_GRID,
  columnStats,
  degenerateTargets,
  evaluateWithLambda,
  nestedEvaluate,
  selectLambdas,
  standardize,
  weightedSkill,
  type EvalRow,
  type GroupBy,
  type ParamStats,
  type RowTransform,
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
  /**
   * Embedding features to keep: 0 drops it, a value below the embedding's own
   * dimension projects onto that many principal components, anything else keeps
   * it raw. See {@link DEFAULT_EMBEDDING_DIM}.
   */
  embeddingDim?: number;
  /** Describe each image's whole shoot alongside it (see develop/session.ts). */
  sessionContext?: boolean;
}

const DEFAULT_FALLBACK_LAMBDA = 1000;
const DEFAULT_GATE_THRESHOLD = 0.02;

/**
 * Principal components kept from the CLIP embedding.
 *
 * Raw 512 dimensions on a few hundred photographs is p≫n, and on the reference
 * catalog carrying them cost more than dropping them outright (colour skill
 * 0.019 raw against 0.046 dropped, losing on 12 fold shuffles out of 12). That
 * catalog's colour branch would in fact do marginally better at 0 — but its
 * black-and-white branch would not, and neither would a photographer whose style
 * genuinely follows the subject. Sixteen components keep the semantic input
 * available at a cost that measures as zero here, rather than baking one
 * catalog's answer into everybody's tool.
 */
export const DEFAULT_EMBEDDING_DIM = 16;

/**
 * Photographs required per session-context feature before a branch uses it.
 *
 * The descriptor doubles the photometric block, and a branch has to have enough
 * images to estimate those columns. On the reference catalog the colour branch
 * (428 images, 44 context features) gained — headline 0.008 → 0.014, Contrast
 * 3% → 24% — while the black-and-white one (125) lost. Four samples per feature
 * puts the cut between them; it is a rule about sample count, not about which
 * side scored better, so it stays honest on a catalog shaped differently.
 */
export const SESSION_CONTEXT_SAMPLES_PER_FEATURE = 4;

interface RawRow {
  file: string;
  embedding: number[];
  features: number[];
  sessionMean: number[];
  develop: Record<string, number>;
  meta: AsShotMeta;
  treatment: Treatment;
  render: RenderProfile;
}

/** How often each rendering appears in a branch, most common first. */
function renderCounts(rows: RawRow[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = renderKey(r.render);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Renderings used on ≥3 of the branch's images, in a stable order. */
function buildRenderVocab(rows: RawRow[]): string[] {
  return renderCounts(rows).filter(([, c]) => c >= 3).map(([k]) => k).sort();
}

/** The branch's most common rendering — what prediction assumes and writes out. */
function defaultRenderFor(rows: RawRow[]): BranchModel['defaultRender'] {
  const top = renderCounts(rows)[0]?.[0];
  const render = rows.find((r) => renderKey(r.render) === top)?.render;
  if (!render) return {};
  return {
    ...(render.profile ? { profile: render.profile } : {}),
    ...(render.look ? { look: render.look } : {}),
  };
}

/** The Look elements this branch might have to emit, by name. */
function looksFor(rows: RawRow[], looks: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const name = r.render.look;
    if (name && !out[name] && looks[name]) out[name] = looks[name];
  }
  return out;
}

/** B&W vs colour, from the explicit field or the edit structure. */
function deriveTreatment(r: { treatment?: Treatment; develop: Record<string, number> }): Treatment {
  return r.treatment ?? treatmentFromDevelop(r.develop);
}

function buildRows(dataset: DevelopDataset): RawRow[] {
  // Session context comes from EVERY record, not just the edited ones. An
  // unedited frame carries no target but describes the shoot just as well, and a
  // session mean built only from the frames that survived the cull is a biased
  // picture of the light the photographer was working in. Exporting the whole
  // folder therefore improves the model without adding a single training row.
  const context = buildSessionContext(dataset.results);
  const rows: RawRow[] = [];
  for (const r of dataset.results) {
    if (!r.embedding?.length || !r.features?.length) continue;
    if (Object.keys(r.develop).length === 0) continue; // edited-only
    rows.push({
      sessionMean: contextFor(context, r.file, r.features),
      file: r.file,
      embedding: r.embedding,
      features: r.features,
      // The point tone curve becomes per-knot targets here, from the curve the
      // dataset already carries — no re-export needed to start predicting it.
      develop: withCurveTargets(r.develop, r.curve),
      meta: r.asShot,
      treatment: deriveTreatment(r),
      render: { profile: r.baseProfile, look: r.look },
    });
  }
  return rows;
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/** Train one treatment's model over its shared+branch parameters. */
function trainBranch(
  raw: RawRow[],
  treatment: Treatment,
  options: TrainOptions,
  looks: Record<string, string>,
): BranchModel {
  const params = paramsForTreatment(treatment);
  const folds = options.folds ?? 5;
  const groupBy: GroupBy = options.groupBy ?? 'folder';
  const gateThreshold = options.gateThreshold ?? DEFAULT_GATE_THRESHOLD;
  const renderVocab = buildRenderVocab(raw);

  // The embedding block leads the feature vector so a fold-local projection can
  // replace exactly that slice (see assemble.ts). `keep` is how many of its
  // features survive; 0 means the block is dropped before it is ever assembled.
  const embeddingDim = raw[0]?.embedding.length ?? 0;
  const requested = options.embeddingDim ?? DEFAULT_EMBEDDING_DIM;
  const keep = Math.max(0, Math.min(requested, embeddingDim));
  const compress = keep > 0 && keep < embeddingDim;

  // Describing the shoot doubles the photometric block, which a small branch
  // cannot pay for: it needs enough photographs to estimate the extra columns.
  // Measured on the reference catalog — 428 colour images gained, 125 B&W ones
  // lost. The test is on sample count alone, never on the resulting score, so it
  // cannot quietly turn into "keep whichever way scored better".
  const contextWidth = raw[0]?.sessionMean.length ?? 0;
  const wantContext = options.sessionContext ?? true;
  const useContext = wantContext && contextWidth > 0 && raw.length >= contextWidth * SESSION_CONTEXT_SAMPLES_PER_FEATURE;

  const rows: EvalRow[] = raw.map((r) => ({
    x: [
      ...assembleFeatures(keep > 0 ? r.embedding : [], r.features, useContext ? r.sessionMean : [], r.meta),
      ...renderOneHot(renderKey(r.render), renderVocab),
    ],
    deltas: targetDeltas(params, r.develop, r.meta),
    abs: actualAbsVec(params, r.develop, r.meta),
    meta: r.meta,
    group: sessionKey(r.file),
  }));

  const degenerate = degenerateTargets(rows, params.length);

  // Refitted inside every fold. The projection never sees a target, but one
  // chosen with the held-out fold in hand still flatters the score it produces.
  const transform: RowTransform | undefined = compress
    ? (train) => {
        const model = fitPca(train.map((r) => r.x.slice(0, embeddingDim)), keep);
        return (x) => [...applyPca(x.slice(0, embeddingDim), model), ...x.slice(embeddingDim)];
      }
    : undefined;

  let gateStats: ParamStats[] = [];
  let randomStats: ParamStats[] = [];
  // λ per parameter. A fixed --lambda applies to all of them; otherwise each one
  // gets the shrinkage its own held-out evidence asks for.
  let lambdas = params.map(() => options.lambda ?? DEFAULT_FALLBACK_LAMBDA);
  let heldOut = 0;

  if (rows.length >= folds * 4) {
    if (options.lambda === undefined) {
      lambdas = selectLambdas(rows, params, { folds, groupBy, grid: LAMBDA_GRID, transform });
      // The gate has to pay for that search: λ is re-chosen inside each outer
      // fold, so no parameter is scored on the split that picked its λ.
      gateStats = nestedEvaluate(rows, params, { folds, groupBy, grid: LAMBDA_GRID, transform });
    } else {
      gateStats = evaluateWithLambda(rows, params, { folds, groupBy, transform }, lambdas);
    }
    // The leakage-prone split, at the same λ, purely for contrast in the report.
    randomStats = evaluateWithLambda(rows, params, { folds, groupBy: 'none', transform }, lambdas);
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
      skillSd: round4(gate?.skillSd ?? 0),
      skillRandom: round4(rand?.skill ?? 0),
      degenerate: isDegenerate,
      gated,
      ...(gated ? { gateReason: isDegenerate ? ('degenerate' as const) : ('low-skill' as const) } : {}),
    };
  });

  // The shipped model: the projection is refitted one last time on everything,
  // and stored, because inference has to reproduce it exactly.
  const pca = compress ? fitPca(rows.map((r) => r.x.slice(0, embeddingDim)), keep) : undefined;
  const finalX = rows.map((r) =>
    pca ? [...applyPca(r.x.slice(0, embeddingDim), pca), ...r.x.slice(embeddingDim)] : r.x,
  );

  const featStats = columnStats(finalX);
  const deltaStats = columnStats(rows.map((r) => r.deltas));
  const ne = buildNormalEquations(finalX.map((x) => standardize(x, featStats)), rows.map((r) => standardize(r.deltas, deltaStats)));
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
    renderVocab,
    defaultRender: defaultRenderFor(raw),
    looks: looksFor(raw, looks),
    embeddingFeatures: keep,
    sessionFeatures: useContext ? contextWidth : 0,
    ...(pca ? { embeddingPca: { mean: pca.mean.map(round6), components: pca.components.map((c) => c.map(round6)) } } : {}),
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
  const looks = dataset.looks ?? {};
  for (const treatment of ['color', 'bw'] as const) {
    if (byTreatment[treatment].length >= 5) {
      branches[treatment] = trainBranch(byTreatment[treatment], treatment, options, looks);
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
