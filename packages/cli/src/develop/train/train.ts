/**
 * Training orchestration: a develop-export dataset → branched DevelopProfile.
 *
 * Edited photos are split by treatment (colour vs B&W, deterministic from the
 * edit), so a high-contrast B&W edit and a light colour edit never average into a
 * mushy mean. Each treatment is then fitted as **two** ridge models rather than
 * one:
 *
 *  - a **level** head, from the mean photometric description of the whole shoot,
 *    predicting where that shoot's slider sits;
 *  - a **frame** head, from how far this photograph departs from that mean,
 *    predicting how far its slider should depart from the shoot's.
 *
 * Their outputs are added. Splitting them is not tidiness — it is the difference
 * between a prediction and a default. Fitted as one regression, the shoot average
 * is a near-noiseless predictor of that shoot's own offset, so ridge spends its
 * budget there and the per-frame columns come out at a tenth of their honest
 * size: on the reference catalog the model moved Highlights by a standard
 * deviation of 2.3 points inside a shoot where the photographer moved it by 15.3.
 * A frame shot into the sun and one in open shade came back identical.
 *
 * Three things follow from the split, and all three are the point:
 *
 *  1. **Separate gates.** A slider can have a per-shoot level the evidence cannot
 *     predict AND per-frame response it predicts well, or the reverse. One gate
 *     could only ever refuse both.
 *  2. **Separate λ.** Selected on the *de-shrunk* held-out skill, not the raw one,
 *     because a search scored on MAE alone systematically prefers the flattest
 *     model on offer.
 *  3. **A de-shrinking slope per head.** Ridge returns an under-dispersed
 *     conditional mean; the held-out slope of truth on prediction says how much
 *     reach that cost, and it is put back. See `evaluate.ts`.
 *
 * The evaluation itself lives in `evaluate.ts` — sessions held out, baseline in
 * delta space — and is shared with `diagnose` so the two cannot disagree about
 * what skill means.
 */
import {
  DEVELOP_PARAMS,
  SCHEMA_VERSION,
  decodeDelta,
  paramsForTreatment,
  renderKey,
  treatmentFromDevelop,
  withCurveTargets,
  type AsShotMeta,
  type DevelopParam,
  type RenderProfile,
  type Treatment,
} from '../develop/schema.js';
import { baseFeatures, deviationFrom, targetDeltas, actualAbsVec, renderOneHot, AS_SHOT_DIM } from '../develop/assemble.js';
import { applyMask, frameMask, levelMask, featureSetKey, type FeatureLayout } from '../develop/featureSets.js';
import { buildSessionContext, contextFor, sessionKey } from '../develop/session.js';
import { buildNormalEquations, solveRidge } from './regress.js';
import { VERSION } from '../../version.js';
import { fitPca, applyPca, type PcaModel } from './pca.js';
import {
  EPS,
  LAMBDA_GRID,
  MAX_RESPONSE,
  assignFolds,
  clampResponse,
  columnStats,
  degenerateTargets,
  evaluateWithLambda,
  heldOutDeltas,
  nestedEvaluate,
  selectLambdas,
  standardize,
  weightedSkill,
  type EvalRow,
  type GroupBy,
  type ParamStats,
  type RowTransform,
} from './evaluate.js';
import type { BranchModel, DevelopDataset, DevelopProfile, HeadEval, HeadModel, ParamEval } from '../types.js';

export interface TrainOptions {
  name: string;
  lambda?: number;
  folds?: number;
  /** Fold policy for the gate metric (default: hold whole sessions out). */
  groupBy?: GroupBy;
  /** Skill at or below which the level head falls back to the constant. 0 = off. */
  gateThreshold?: number;
  /**
   * Skill at or below which the frame head stops modulating per photograph.
   *
   * Lower than the level gate on purpose. The two answer different questions and
   * cost different things when wrong: a level that is a point or two worse than
   * the photographer's average is just a worse average, while per-frame response
   * that is even slightly right is the difference between a prediction and a
   * default — and its baseline (the shoot's own true level) is a far harder one
   * to beat than the catalog-wide mean.
   */
  frameGateThreshold?: number;
  /**
   * Embedding features to keep: 0 drops it, a value below the embedding's own
   * dimension projects onto that many principal components, anything else keeps
   * it raw. See {@link DEFAULT_EMBEDDING_DIM}.
   */
  embeddingDim?: number;
  /**
   * How willing the model is to move a slider, 0..1. See {@link conservatismFor}.
   *
   * Overridden by an explicit `gateThreshold` / `frameGateThreshold`, so the two
   * can be mixed: raise the boldness and still pin one gate by hand.
   */
  boldness?: number;
  /**
   * Called as the fit advances, in the arbitrary work units of {@link COST}.
   *
   * This whole function is synchronous, so nothing outside it gets to run until
   * it returns: a caller that wants to say anything while a catalog is being
   * fitted has to be told from in here. The units are weighted by measured cost
   * rather than counted, so the fraction moves at a roughly steady rate instead
   * of stalling on the one pass that dominates the time.
   */
  onProgress?: (done: number, total: number, label: string) => void;
}

/** One weighted unit of held-out work finished. */
type Tick = (cost: number, detail: string) => void;

/**
 * What each held-out pass costs, relative to one λ search over the grid.
 *
 * The nested gate re-runs that search inside every outer fold, so it is `folds`
 * times the price — which is why a bar counting passes rather than weighting
 * them sits at 8% for two minutes and then finishes in one jump.
 */
const COST = {
  /** The λ grid search: one pass over the folds, |grid| solves in each. */
  search: (auto: boolean): number => (auto ? 1 : 0),
  /** The nested gate: that whole search repeated inside every outer fold. */
  gate: (folds: number, auto: boolean): number => (auto ? folds : COST.score),
  /**
   * Re-scoring or replaying a λ already chosen: one pass, a couple of solves.
   *
   * 1.2 rather than the ~0.2 the solve count suggests, because these passes pay
   * the same fold setup — projection, standardization, normal equations — as the
   * search does, and on a real catalog that is most of the time. Measured on the
   * colour branch of a 553-image catalog: 2m50s in the two head searches against
   * 2m30s in the eight re-scores that follow them.
   */
  score: 1.2,
};

/** Passes per bucket: two heads fitted and gated, then four re-scores and four replays. */
function branchUnits(buckets: number, folds: number, auto: boolean): number {
  return buckets * (2 * (COST.search(auto) + COST.gate(folds, auto)) + 8 * COST.score);
}

/** Per-sample units now — see LAMBDA_GRID. Roughly the old 1000 at n≈400. */
const DEFAULT_FALLBACK_LAMBDA = 2;
const DEFAULT_GATE_THRESHOLD = 0.02;
const DEFAULT_FRAME_GATE_THRESHOLD = 0.01;

/** The four brakes that decide how far a prediction is allowed to travel. */
export interface Conservatism {
  /** Standard deviations of its own fold spread a parameter must clear. */
  gateZ: number;
  /** Absolute floor, for parameters whose folds agree exactly. */
  gateFloor: number;
  maxResponse: number;
  frameMaeAllowance: number;
}

/**
 * One knob across every mechanism that holds a prediction back.
 *
 * Each of the four defaults below was chosen on its own, defensibly, to avoid
 * claiming more than the evidence supports — and their *product* is a model that
 * gates 70 of 77 colour parameters and emits a constant for them. Every brake is
 * individually reasonable and collectively they stop the car.
 *
 * That trade is not the tool's to make. A photographer who wants a starting point
 * rather than a safe average is asking for a model that moves, and is willing to
 * be wrong more often to get it; "closest on average" and "worth opening in
 * Lightroom" are different targets and only one of them can be measured here.
 *
 * 0 is exactly today's behaviour, so an existing profile retrains byte-identical.
 * 1 opens the gates completely, lets the de-shrinking slope reach 8x instead of
 * 3x, and allows the frame head to spend 30% more held-out error buying back its
 * reach instead of 5%.
 *
 * **The skill numbers get worse as this goes up, by construction.** That is not a
 * regression: MAE is minimised by the flat answer, so any model that moves more
 * pays for it. Judge this one in Lightroom, not in `BASELINE.md`.
 */
export function conservatismFor(boldness: number): Conservatism {
  const b = Math.min(1, Math.max(0, Number.isFinite(boldness) ? boldness : 0));
  const mix = (at0: number, at1: number): number => at0 + (at1 - at0) * b;
  return {
    gateZ: mix(1, 0),
    gateFloor: mix(DEFAULT_GATE_THRESHOLD, 0),
    maxResponse: mix(MAX_RESPONSE, 8),
    frameMaeAllowance: mix(FRAME_MAE_ALLOWANCE, 0.3),
  };
}

/**
 * How much held-out MAE the frame head may cost, once its output is stretched
 * back to the amplitude the evidence supports.
 *
 * The one place where this tool deliberately does not minimise error. Restoring
 * the reach of an under-dispersed prediction always costs MAE — the shrunk output
 * is the MAE-optimal one — so a hard "must not be worse" rule would keep choosing
 * the flat answer, which is exactly the behaviour this whole design exists to end.
 * A slider is not scored on average error by the person moving it: a Highlights
 * that sits at −53 on every frame of a shoot is *useless* at any MAE, and one that
 * recovers a blown sky and leaves an open-shade frame alone is worth a couple of
 * points of error. Five per cent is that couple of points, stated out loud rather
 * than hidden in a threshold.
 *
 * The level head gets no such allowance: there the photographer's own constant is
 * a legitimate answer, and a level that is worse than it is simply worse.
 */
const FRAME_MAE_ALLOWANCE = 0.05;

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

interface RawRow {
  file: string;
  /** `[ raw embedding | colour | as-shot ]` — this photograph, on its own. */
  base: number[];
  /** The mean of the same vector over the whole shoot, unedited frames included. */
  sessionMean: number[];
  develop: Record<string, number>;
  meta: AsShotMeta;
  treatment: Treatment;
  render: RenderProfile;
  /** Importance in the fit; 1 for an ordinary catalog edit. See dataset/weight.ts. */
  weight: number;
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
  // Described over the *base* vector, not the colour block alone: the shoot's
  // mean embedding and mean capture state are as much a part of "what this shoot
  // looks like" as its mean luminance, and the frame head needs every column it
  // reads to have a session counterpart to be subtracted from.
  const context = buildSessionContext(
    dataset.results
      .filter((r) => r.embedding?.length && r.features?.length)
      .map((r) => ({ file: r.file, features: baseFeatures(r.embedding, r.features, r.asShot) })),
  );
  const rows: RawRow[] = [];
  for (const r of dataset.results) {
    if (!r.embedding?.length || !r.features?.length) continue;
    if (Object.keys(r.develop).length === 0) continue; // never touched at all
    // Carries crs tags but every one of them sits at its neutral default: the
    // editor wrote them, the photographer did not. Training on those teaches the
    // model to predict "change nothing". Older datasets have no flag, and were
    // filtered at export time by --edited-only instead.
    if (r.edited === false) continue;
    const base = baseFeatures(r.embedding, r.features, r.asShot);
    rows.push({
      base,
      sessionMean: contextFor(context, r.file, base),
      file: r.file,
      // The point tone curve becomes per-knot targets here, from the curve the
      // dataset already carries — no re-export needed to start predicting it.
      develop: withCurveTargets(r.develop, r.curve),
      meta: r.asShot,
      treatment: deriveTreatment(r),
      render: { profile: r.baseProfile, look: r.look },
      // Absent on every ordinary export, and on every dataset written before
      // weighting existed: an unmarked photograph is worth exactly one.
      weight: Number.isFinite(r.weight) && r.weight! > 0 ? r.weight! : 1,
    });
  }
  return rows;
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/**
 * Replace the leading raw-embedding slice with `keep` components, or drop it.
 *
 * Refitted inside every fold by the evaluation machinery. The projection never
 * sees a target, but one chosen with the held-out fold in hand still flatters the
 * score it produces.
 *
 * **Memoised, and it matters more than anything else in this file.** The
 * projection depends only on which rows are training — never on which parameter
 * bucket is being fitted — yet a branch fits a dozen buckets over the same folds,
 * re-selects λ on inner folds inside each of them, and then re-scores everything
 * twice more. Fitting it afresh each time was 99% of `develop train`: 6m38 on 553
 * images against 4.7s with the embedding dropped altogether. Power iteration over
 * 512 dimensions is 16 components × 40 passes × n rows, and it was being paid
 * some fifteen hundred times per branch for maybe forty distinct training sets.
 */
function embeddingTransform(rawDim: number, keep: number): RowTransform | undefined {
  if (rawDim === 0 || keep === rawDim) return undefined;
  if (keep === 0) return () => (x) => x.slice(rawDim);
  const cache = new Map<string, PcaModel>();
  return (train) => {
    // Row ids identify the training set exactly. Without them the safe answer is
    // to refit: two different folds of equal size must never share a projection.
    const key = train.every((r) => r.id !== undefined) ? train.map((r) => r.id).join(',') : null;
    let model = key === null ? undefined : cache.get(key);
    if (!model) {
      model = fitPca(train.map((r) => r.x.slice(0, rawDim)), keep);
      if (key !== null) cache.set(key, model);
    }
    const fitted = model;
    return (x) => [...applyPca(x.slice(0, rawDim), fitted), ...x.slice(rawDim)];
  };
}

/** Parameters sharing a feature mask, fitted together in one normal-equation system. */
function bucketize(params: DevelopParam[]): Map<string, number[]> {
  const buckets = new Map<string, number[]>();
  for (let k = 0; k < params.length; k++) {
    const key = featureSetKey(params[k]!.key, params[k]!.group);
    const at = buckets.get(key);
    if (at) at.push(k);
    else buckets.set(key, [k]);
  }
  return buckets;
}

interface HeadFit {
  head: HeadModel;
  /** Raw held-out stats, sessions out — what the gate reads. */
  gate: ParamStats[];
  degenerate: boolean[];
  lambdas: number[];
  /** Per-bucket masks, kept so the shipped-model passes can reuse them. */
  maskFor: Map<string, boolean[]>;
  buckets: Map<string, number[]>;
  transform?: RowTransform;
}

/**
 * Fit one head: λ per parameter, held-out stats, and the shipped weights.
 *
 * Nothing here knows whether it is the level head or the frame head — the caller
 * decides that by what it puts in `rows` (session descriptor vs frame deviation,
 * session level vs deviation target) and which mask it hands over.
 */
function fitHead(
  rows: EvalRow[],
  params: DevelopParam[],
  maskOf: (param: DevelopParam) => boolean[],
  rawEmbedding: number,
  keep: number,
  opts: { folds: number; groupBy: GroupBy; lambda?: number; evaluate: boolean; maxResponse: number; tick?: Tick },
): HeadFit {
  const buckets = bucketize(params);
  const transform = embeddingTransform(rawEmbedding, keep);
  const maskFor = new Map(
    [...buckets.entries()].map(([bucket, at]) => [bucket, maskOf(params[at[0]!]!)]),
  );
  const maskedTransform = (mask: boolean[]): RowTransform => {
    // Half the buckets — every tonal and white-balance parameter — zero the whole
    // embedding block anyway (see featureSets.ts). Projecting 512 dimensions onto
    // 16 components and then discarding all 16 is the most expensive no-op in the
    // tool, so those buckets get zeros of the right width instead: after masking
    // the two are the same vector.
    if (!mask.slice(0, keep).some(Boolean)) {
      const blank = new Array<number>(keep).fill(0);
      return () => (x) => applyMask([...blank, ...x.slice(rawEmbedding)], mask);
    }
    return (train) => {
      const base = transform ? transform(train) : (x: number[]) => x;
      return (x) => applyMask(base(x), mask);
    };
  };

  const degenerate = degenerateTargets(rows, params.length);
  const lambdas = params.map(() => opts.lambda ?? DEFAULT_FALLBACK_LAMBDA);
  const gate = new Array<ParamStats>(params.length);

  if (opts.evaluate) {
    for (const [key, at] of buckets) {
      const sub = at.map((k) => params[k]!);
      const subRows: EvalRow[] = rows.map((r) => ({
        ...r,
        deltas: at.map((k) => r.deltas[k]!),
        abs: at.map((k) => r.abs[k]!),
        ...(r.offset ? { offset: at.map((k) => r.offset![k]!) } : {}),
      }));
      const tf = maskedTransform(maskFor.get(key)!);
      const cv = { folds: opts.folds, groupBy: opts.groupBy, grid: LAMBDA_GRID, transform: tf, maxResponse: opts.maxResponse };
      const auto = opts.lambda === undefined;
      const subLambdas = auto ? selectLambdas(subRows, sub, cv) : sub.map(() => opts.lambda!);
      opts.tick?.(COST.search(auto), `${key} · λ`);
      // The gate has to pay for that search: λ is re-chosen inside each outer
      // fold, so no parameter is scored on the split that picked its λ.
      const subGate = auto
        ? nestedEvaluate(subRows, sub, cv)
        : evaluateWithLambda(subRows, sub, cv, subLambdas);
      opts.tick?.(COST.gate(opts.folds, auto), `${key} · gate`);
      at.forEach((k, i) => {
        lambdas[k] = subLambdas[i]!;
        gate[k] = subGate[i]!;
      });
    }
  }

  // The shipped model: the projection is refitted one last time on everything,
  // and stored, because inference has to reproduce it exactly.
  const pca = keep > 0 && keep < rawEmbedding ? fitPca(rows.map((r) => r.x.slice(0, rawEmbedding)), keep) : undefined;
  const project = (x: number[]): number[] =>
    keep === rawEmbedding || rawEmbedding === 0
      ? x
      : pca
        ? [...applyPca(x.slice(0, rawEmbedding), pca), ...x.slice(rawEmbedding)]
        : x.slice(rawEmbedding);
  const finalX = rows.map((r) => project(r.x));

  const featStats = columnStats(finalX);
  // Target standardization stays unweighted on purpose: the level head's mean is
  // what a gated parameter emits as "the photographer's constant", and a corrected
  // shoot must not quietly redefine that — `develop calibrate` is where a wrong
  // constant is fixed, on evidence built for the job. Weights belong to the fit.
  const targetStats = columnStats(rows.map((r) => r.deltas));
  // Masking happens *after* standardization: a column zeroed first would have its
  // own mean and spread measured on the zeros, and inference standardizes with the
  // stats stored here. Zeroed afterwards the column is constant, so centering in
  // the normal equations kills it and its weight comes out 0 — identical to
  // dropping it, while every stored width stays what `predict` expects.
  const stdX = finalX.map((x) => standardize(x, featStats));
  const stdY = rows.map((r) => standardize(r.deltas, targetStats));
  const rowWeights = rows.map((r) => r.weight ?? 1);

  const weights = new Array<number[]>(params.length);
  const bias = new Array<number>(params.length);
  for (const [key, at] of buckets) {
    const mask = maskFor.get(key)!;
    const ne = buildNormalEquations(
      stdX.map((x) => applyMask(x, mask)),
      stdY.map((y) => at.map((k) => y[k]!)),
      rowWeights,
    );
    const solved = new Map([...new Set(at.map((k) => lambdas[k]!))].map((l) => [l, solveRidge(ne, l)]));
    at.forEach((k, i) => {
      const s = solved.get(lambdas[k]!)!;
      weights[k] = s.weights[i]!;
      bias[k] = s.bias[i]!;
    });
  }

  const head: HeadModel = {
    features: finalX[0]?.length ?? 0,
    embeddingFeatures: keep,
    ...(pca ? { embeddingPca: { mean: pca.mean.map(round6), components: pca.components.map((c) => c.map(round6)) } } : {}),
    featureMean: featStats.mean.map(round6),
    featureStd: featStats.std.map(round6),
    targetMean: targetStats.mean.map(round6),
    targetStd: targetStats.std.map(round6),
    weights: weights.map((w) => w.map(round6)),
    bias: bias.map(round6),
    paramLambda: lambdas,
    response: params.map(() => 1),
    gated: params.map(() => false),
  };
  return { head, gate, degenerate, lambdas, maskFor, buckets, transform };
}

/** Re-score a fitted head exactly as it will ship: gates applied, output de-shrunk. */
function shippedStats(
  fit: HeadFit,
  rows: EvalRow[],
  params: DevelopParam[],
  opts: { folds: number; groupBy: GroupBy; maxResponse: number; tick?: Tick },
): ParamStats[] {
  const out = new Array<ParamStats>(params.length);
  for (const [key, at] of fit.buckets) {
    const sub = at.map((k) => params[k]!);
    const subRows: EvalRow[] = rows.map((r) => ({
      ...r,
      deltas: at.map((k) => r.deltas[k]!),
      abs: at.map((k) => r.abs[k]!),
      ...(r.offset ? { offset: at.map((k) => r.offset![k]!) } : {}),
    }));
    const mask = fit.maskFor.get(key)!;
    const tf: RowTransform = (train) => {
      const base = fit.transform ? fit.transform(train) : (x: number[]) => x;
      return (x) => applyMask(base(x), mask);
    };
    const stats = evaluateWithLambda(
      subRows,
      sub,
      {
        folds: opts.folds,
        groupBy: opts.groupBy,
        transform: tf,
        maxResponse: opts.maxResponse,
        shipped: {
          scale: at.map((k) => fit.head.response[k]!),
          suppress: at.map((k) => fit.head.gated[k]!),
        },
      },
      at.map((k) => fit.lambdas[k]!),
    );
    at.forEach((k, i) => { out[k] = stats[i]!; });
    opts.tick?.(COST.score, `${key} · shipped`);
  }
  return out;
}

/**
 * The two heads added together, scored against the photographer's constant.
 *
 * The headline number, and it cannot be delegated to either head's own pass:
 * those measure a head against the *other* head's answer (the frame head against
 * the shoot's level, the level head against the catalog mean), which is the right
 * question for gating one of them and the wrong one for reporting the pair. Here
 * the model is the sum of what both heads produced held out, and the baseline is
 * "apply my average edit" — the same comparison every earlier version of this
 * tool reported, so the numbers are still commensurable.
 */
function endToEndStats(
  rows: EvalRow[],
  params: DevelopParam[],
  predicted: number[][],
  opts: { folds: number; groupBy: GroupBy },
): ParamStats[] {
  const P = params.length;
  const fold = assignFolds(rows, opts.folds, opts.groupBy);
  const perFold: { model: number[]; base: number[] }[] = [];
  const modelErr = new Array<number>(P).fill(0);
  const baseErr = new Array<number>(P).fill(0);
  let counted = 0;

  for (let f = 0; f < opts.folds; f++) {
    const trainIdx: number[] = [];
    const valIdx: number[] = [];
    rows.forEach((_, i) => (fold[i] === f ? valIdx : trainIdx).push(i));
    if (trainIdx.length < 2 || valIdx.length === 0) continue;

    const meanDelta = new Array<number>(P).fill(0);
    for (const i of trainIdx) for (let k = 0; k < P; k++) meanDelta[k]! += rows[i]!.deltas[k]!;
    for (let k = 0; k < P; k++) meanDelta[k]! /= trainIdx.length;

    const acc = { model: new Array<number>(P).fill(0), base: new Array<number>(P).fill(0) };
    perFold.push(acc);
    for (const i of valIdx) {
      const r = rows[i]!;
      for (let k = 0; k < P; k++) {
        const m = Math.abs(decodeDelta(params[k]!, predicted[i]![k]!, r.meta) - r.abs[k]!);
        const b = Math.abs(decodeDelta(params[k]!, meanDelta[k]!, r.meta) - r.abs[k]!);
        modelErr[k]! += m; acc.model[k]! += m;
        baseErr[k]! += b; acc.base[k]! += b;
      }
    }
    counted += valIdx.length;
  }

  const n = Math.max(1, counted);
  return params.map((_, k) => {
    const modelMae = modelErr[k]! / n;
    const baselineMae = baseErr[k]! / n;
    const each = perFold.filter((p) => p.base[k]! > EPS).map((p) => 1 - p.model[k]! / p.base[k]!);
    let skillSd = 0;
    if (each.length > 1) {
      const mean = each.reduce((s, v) => s + v, 0) / each.length;
      skillSd = Math.sqrt(each.reduce((s, v) => s + (v - mean) ** 2, 0) / each.length);
    }
    return {
      modelMae,
      baselineMae,
      skill: baselineMae > EPS ? 1 - modelMae / baselineMae : 0,
      skillSd,
      response: 1,
    };
  });
}

/** The same head's held-out output per row, in delta space, exactly as it ships. */
function shippedHeldOut(
  fit: HeadFit,
  rows: EvalRow[],
  params: DevelopParam[],
  opts: { folds: number; groupBy: GroupBy; maxResponse: number; tick?: Tick },
): number[][] {
  const out = rows.map(() => new Array<number>(params.length).fill(0));
  for (const [key, at] of fit.buckets) {
    const mask = fit.maskFor.get(key)!;
    const tf: RowTransform = (train) => {
      const base = fit.transform ? fit.transform(train) : (x: number[]) => x;
      return (x) => applyMask(base(x), mask);
    };
    const sub = heldOutDeltas(
      rows.map((r) => ({ ...r, deltas: at.map((k) => r.deltas[k]!), abs: at.map((k) => r.abs[k]!) })),
      at.length,
      {
        folds: opts.folds,
        groupBy: opts.groupBy,
        transform: tf,
        maxResponse: opts.maxResponse,
        shipped: {
          scale: at.map((k) => fit.head.response[k]!),
          suppress: at.map((k) => fit.head.gated[k]!),
        },
      },
      at.map((k) => fit.lambdas[k]!),
    );
    rows.forEach((_, i) => { at.forEach((k, j) => { out[i]![k] = sub[i]![j]!; }); });
    opts.tick?.(COST.score, `${key} · end to end`);
  }
  return out;
}

/**
 * Train one treatment's model: a level head over the shoot, a frame head over
 * what this photograph does differently, and the evidence for each separately.
 */
function trainBranch(
  raw: RawRow[],
  treatment: Treatment,
  dims: { embedding: number; colour: number },
  options: TrainOptions,
  looks: Record<string, string>,
  report?: (cost: number, label: string) => void,
): BranchModel {
  const params = paramsForTreatment(treatment);
  const folds = options.folds ?? 5;
  const groupBy: GroupBy = options.groupBy ?? 'folder';
  const brakes = conservatismFor(options.boldness ?? 0);
  // An explicit threshold still wins, and now pins the *floor* of the adaptive
  // bar rather than replacing it: "never let anything below this through",
  // leaving the per-parameter noise term to do the rest.
  if (options.gateThreshold !== undefined) brakes.gateFloor = options.gateThreshold;
  const gateThreshold = brakes.gateFloor;
  const frameGateThreshold = options.frameGateThreshold ?? brakes.gateFloor;
  const renderVocab = buildRenderVocab(raw);

  const requested = options.embeddingDim ?? DEFAULT_EMBEDDING_DIM;
  const keep = Math.max(0, Math.min(requested, dims.embedding));
  const layout: FeatureLayout = {
    embedding: keep,
    colour: dims.colour,
    asShot: AS_SHOT_DIM,
    render: renderVocab.length,
  };

  // ── the two views of one photograph ────────────────────────────────────────
  // The level rows are identical for every frame of a shoot; the frame rows sum
  // to zero within one. That is what makes the two fits independent rather than
  // competing, and it is the whole fix: a slider can now have a per-shoot level
  // the model refuses to predict AND a per-frame response it predicts well.
  const level = raw.map((r) => [...r.sessionMean, ...renderOneHot(renderKey(r.render), renderVocab)]);
  const frame = raw.map((r) => deviationFrom(r.base, r.sessionMean));

  const deltas = raw.map((r) => targetDeltas(params, r.develop, r.meta));
  const abs = raw.map((r) => actualAbsVec(params, r.develop, r.meta));
  const groups = raw.map((r) => sessionKey(r.file));

  // The shoot's own level per parameter: the mean target of the frames that
  // share a folder. The frame head's target is what is left over.
  const levelOf = new Map<string, number[]>();
  const counts = new Map<string, number>();
  for (let i = 0; i < raw.length; i++) {
    const g = groups[i]!;
    let acc = levelOf.get(g);
    if (!acc) { acc = new Array<number>(params.length).fill(0); levelOf.set(g, acc); }
    for (let k = 0; k < params.length; k++) acc[k]! += deltas[i]![k]!;
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  for (const [g, acc] of levelOf) {
    const n = counts.get(g)!;
    for (let k = 0; k < acc.length; k++) acc[k]! /= n;
  }

  const levelRows: EvalRow[] = raw.map((r, i) => ({
    id: i,
    x: level[i]!,
    deltas: levelOf.get(groups[i]!)!,
    abs: abs[i]!,
    meta: r.meta,
    group: groups[i]!,
    weight: r.weight,
  }));
  const frameRows: EvalRow[] = raw.map((r, i) => ({
    id: i,
    x: frame[i]!,
    deltas: deltas[i]!.map((d, k) => d - levelOf.get(groups[i]!)![k]!),
    abs: abs[i]!,
    meta: r.meta,
    group: groups[i]!,
    weight: r.weight,
    // Scored against the shoot's real level: "given that we know where this shoot
    // sits, does knowing the frame help?" — the question a photographer is asking
    // when two frames of one wedding come back with the same Highlights.
    offset: levelOf.get(groups[i]!)!,
  }));

  const evaluate = raw.length >= folds * 4;
  const tickFor = (head: string): Tick | undefined =>
    report && ((cost, detail) => report(cost, `${treatment} ${head} · ${detail}`));

  const levelFit = fitHead(levelRows, params, (p) => levelMask(p.key, p.group, layout), dims.embedding, keep,
    { folds, groupBy, lambda: options.lambda, evaluate, maxResponse: brakes.maxResponse, tick: tickFor('level') });
  const frameFit = fitHead(frameRows, params, (p) => frameMask(p.key, p.group, layout), dims.embedding, keep,
    { folds, groupBy, lambda: options.lambda, evaluate, maxResponse: brakes.maxResponse, tick: tickFor('frame') });

  // ── de-shrink, then gate ───────────────────────────────────────────────────
  // The slope first, because the gate has to judge the output that will actually
  // be written to the sidecar. Scoring the raw ridge fit and then quietly
  // stretching it is how a model gets a respectable number for behaviour nobody
  // would accept: the shrunk output has the lowest error precisely because it
  // hardly moves.
  //
  // It is measured at the λ the model *ships* with, not at the gate's. The gate
  // re-selects λ inside every fold, which makes its held-out output noisier than
  // the final model's — and a slope read off noisier predictions comes out below
  // 1, telling a perfectly well-behaved fit to shrink itself further. Highlights
  // was being handed 0.35 that way, i.e. instructed to move a third as much as it
  // already did.
  let levelShipped: ParamStats[] = [];
  let frameShipped: ParamStats[] = [];
  let endToEnd: ParamStats[] = [];
  let endToEndRandom: ParamStats[] = [];
  if (evaluate) {
    const levelPlain = shippedStats(levelFit, levelRows, params, { folds, groupBy, maxResponse: brakes.maxResponse, tick: tickFor('level') });
    const framePlain = shippedStats(frameFit, frameRows, params, { folds, groupBy, maxResponse: brakes.maxResponse, tick: tickFor('frame') });
    for (let k = 0; k < params.length; k++) {
      levelFit.head.response[k] = clampResponse(levelPlain[k]?.response ?? 1, brakes.maxResponse);
      frameFit.head.response[k] = clampResponse(framePlain[k]?.response ?? 1, brakes.maxResponse);
    }
    levelShipped = shippedStats(levelFit, levelRows, params, { folds, groupBy, maxResponse: brakes.maxResponse, tick: tickFor('level') });
    frameShipped = shippedStats(frameFit, frameRows, params, { folds, groupBy, maxResponse: brakes.maxResponse, tick: tickFor('frame') });
  }

  /**
   * The skill a parameter has to clear to be allowed to move — measured against
   * **its own noise**, not against a constant.
   *
   * A fixed threshold cannot be right for every parameter at once. `skillSd` is
   * the spread of the same skill across held-out folds, and on the reference
   * catalog it ranges from 0.00 to over 1.0: judging all of them against 0.02
   * passes parameters whose apparent skill is a tenth of their measurement noise
   * and blocks parameters that are tightly measured just below it. `Texture` at
   * 2.2% ±20.3% and `Blacks2012` at 4.7% ±4.7% are not the same evidence, and the
   * old gate treated the first as the better one.
   *
   * So the bar is `z` standard deviations above zero, per parameter. A tightly
   * measured 3% now passes where a noisy 15% does not, which is the ordering the
   * evidence actually supports. `z` comes from the boldness knob: 1.0 asks for a
   * full standard deviation of separation, 0 lets any positive skill through.
   *
   * The floor keeps a parameter measured with *zero* observed spread — every fold
   * agreeing exactly, which happens when a slider barely moves — from passing on a
   * skill of 1e-9.
   */
  const bar = (stats: ParamStats): number | null =>
    brakes.gateZ <= 0 && brakes.gateFloor <= 0 ? null : Math.max(brakes.gateFloor, brakes.gateZ * stats.skillSd);

  for (let k = 0; k < params.length; k++) {
    const lg = levelFit.gate[k];
    const fg = frameFit.gate[k];
    // The level competes with the photographer's constant on its own terms, so
    // it has to beat it as it ships. The frame head is judged on whether it
    // *tracks* — a positive raw skill means the signal is there — and is then
    // allowed to spend a little error buying its reach back.
    levelFit.head.gated[k] =
      levelFit.degenerate[k]! ||
      (lg !== undefined && bar(lg) !== null &&
        Math.min(lg.skill, levelShipped[k]?.skill ?? lg.skill) <= bar(lg)!);
    frameFit.head.gated[k] =
      frameFit.degenerate[k]! ||
      (fg !== undefined && bar(fg) !== null &&
        (fg.skill <= bar(fg)! || (frameShipped[k]?.skill ?? 0) < -brakes.frameMaeAllowance));
    // A gated head emits its constant, which *is* the baseline: its skill is 0 by
    // definition, and re-running the folds to rediscover that would be waste.
    if (levelFit.head.gated[k]) { levelFit.head.response[k] = 1; if (levelShipped[k]) levelShipped[k]!.skill = 0; }
    if (frameFit.head.gated[k]) { frameFit.head.response[k] = 1; if (frameShipped[k]) frameShipped[k]!.skill = 0; }
  }

  if (evaluate) {
    // End to end: the frame head sitting on the level the model would really have
    // produced for a shoot it has never seen, not on the level we happen to know.
    const fullRows: EvalRow[] = raw.map((r, i) => ({
      x: [], deltas: deltas[i]!, abs: abs[i]!, meta: r.meta, group: groups[i]!, weight: r.weight,
    }));
    for (const policy of [groupBy, 'none' as const]) {
      const lp = shippedHeldOut(levelFit, levelRows, params, { folds, groupBy: policy, maxResponse: brakes.maxResponse, tick: tickFor('level') });
      const fp = shippedHeldOut(frameFit, frameRows, params, { folds, groupBy: policy, maxResponse: brakes.maxResponse, tick: tickFor('frame') });
      const summed = lp.map((row, i) => row.map((v, k) => v + fp[i]![k]!));
      const stats = endToEndStats(fullRows, params, summed, { folds, groupBy: policy });
      if (policy === groupBy) endToEnd = stats;
      else endToEndRandom = stats;
    }
  }

  const deltaStats = columnStats(deltas);
  const bothDegenerate = params.map((_, k) => levelFit.degenerate[k]! && frameFit.degenerate[k]!);

  const headEval = (stats: ParamStats | undefined, shipped: ParamStats | undefined, head: HeadModel, degenerate: boolean, k: number): HeadEval => ({
    lambda: head.paramLambda[k]!,
    skill: round4(stats?.skill ?? 0),
    skillSd: round4(stats?.skillSd ?? 0),
    shippedSkill: round4(shipped?.skill ?? stats?.skill ?? 0),
    response: round4(head.response[k]!),
    gated: head.gated[k]!,
    ...(head.gated[k] ? { gateReason: degenerate ? ('degenerate' as const) : ('low-skill' as const) } : {}),
  });

  const perParam: ParamEval[] = params.map((param, k) => {
    const levelEval = headEval(levelFit.gate[k], levelShipped[k], levelFit.head, levelFit.degenerate[k]!, k);
    const frameEval = headEval(frameFit.gate[k], frameShipped[k], frameFit.head, frameFit.degenerate[k]!, k);
    return {
      key: param.key,
      group: param.group,
      branch: param.branch,
      weight: param.weight,
      level: levelEval,
      frame: frameEval,
      lambda: levelEval.lambda,
      modelMae: round4(endToEnd[k]?.modelMae ?? 0),
      baselineMae: round4(endToEnd[k]?.baselineMae ?? 0),
      skill: round4(endToEnd[k]?.skill ?? 0),
      skillSd: round4(endToEnd[k]?.skillSd ?? 0),
      skillRandom: round4(endToEndRandom[k]?.skill ?? 0),
      degenerate: bothDegenerate[k]!,
      gated: levelEval.gated && frameEval.gated,
      ...(levelEval.gated && frameEval.gated
        ? { gateReason: bothDegenerate[k] ? ('degenerate' as const) : ('low-skill' as const) }
        : {}),
    };
  });

  const skillOf = (stats: ParamStats[]): number | null =>
    stats.length > 0 ? round4(weightedSkill(stats, params, bothDegenerate) ?? 0) : null;

  return {
    treatment,
    params: params.map((p) => p.key),
    renderVocab,
    level: levelFit.head,
    frame: frameFit.head,
    defaultRender: defaultRenderFor(raw),
    looks: looksFor(raw, looks),
    deltaMean: deltaStats.mean.map(round6),
    deltaStd: deltaStats.std.map(round6),
    samples: raw.length,
    sessions: levelOf.size,
    heldOut: evaluate ? raw.length : 0,
    imageDependentSkill: skillOf(endToEnd),
    imageDependentSkillRandom: skillOf(endToEndRandom),
    withinSessionSkill: skillOf(frameShipped),
    gatedParams: perParam.filter((p) => p.gated).map((p) => p.key),
    flatParams: perParam.filter((p) => p.frame.gated && !p.gated).map((p) => p.key),
    gateThreshold,
    frameGateThreshold,
    perParam,
  };
}

export function train(dataset: DevelopDataset, options: TrainOptions): DevelopProfile {
  const rows = buildRows(dataset);
  if (rows.length < 2) throw new Error(`too few edited images (${rows.length}); need embeddings + color features`);

  const byTreatment: Record<Treatment, RawRow[]> = { color: [], bw: [] };
  for (const r of rows) byTreatment[r.treatment].push(r);

  const embeddingDim = dataset.dim || (dataset.results[0]?.embedding.length ?? 0);
  const colorDim = dataset.colorDim || (dataset.results[0]?.features.length ?? 0);
  const dims = { embedding: embeddingDim, colour: colorDim };

  // The whole plan is known before a single fold is fitted — every pass is one
  // bucket of one head, and how many of each there are follows from the schema.
  // So the bar can be honest about the denominator from the first tick rather
  // than discovering it as it goes.
  const folds = options.folds ?? 5;
  const auto = options.lambda === undefined;
  // Every pass is one bucket of one head, and how many of each there are follows
  // from the schema — so the denominator is knowable before a single fold is
  // fitted, and the bar never has to discover it as it goes. Each branch's share
  // is scaled by its own sample count: a fold costs what it costs to build the
  // normal equations, which is linear in the photographs going into them. The
  // B&W branch is routinely a third the size of the colour one, and weighting
  // them equally is what makes a bar sit at 60% and then sprint.
  const units = new Map<Treatment, number>();
  for (const treatment of ['color', 'bw'] as const) {
    const branchRows = byTreatment[treatment];
    if (branchRows.length < 5 || branchRows.length < folds * 4) continue;
    units.set(treatment, branchUnits(bucketize(paramsForTreatment(treatment)).size, folds, auto) * branchRows.length);
  }
  const total = [...units.values()].reduce((a, b) => a + b, 0);
  let done = 0;
  const reporter = options.onProgress && total > 0
    ? (scale: number) => (cost: number, label: string): void => {
        done = Math.min(total, done + cost * scale);
        options.onProgress!(done, total, label);
      }
    : undefined;

  const branches: DevelopProfile['branches'] = {};
  const looks = dataset.looks ?? {};
  for (const treatment of ['color', 'bw'] as const) {
    if (byTreatment[treatment].length >= 5) {
      branches[treatment] = trainBranch(
        byTreatment[treatment], treatment, dims, options, looks,
        units.has(treatment) ? reporter?.(byTreatment[treatment].length) : undefined,
      );
    }
  }
  if (Object.keys(branches).length === 0) {
    throw new Error('no treatment had enough edited images to train a model (need ≥5 per branch)');
  }

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
    toolVersion: VERSION,
    stats: {
      edited: rows.length,
      color: byTreatment.color.length,
      bw: byTreatment.bw.length,
      described: dataset.results.filter((r) => r.features?.length).length,
    },
  };
}

/** Re-export for callers that enumerate the schema (e.g. reporting). */
export { DEVELOP_PARAMS, EPS };
