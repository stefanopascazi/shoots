/**
 * Held-out evaluation — the one place that decides whether the model is worth
 * anything. Shared by `train` and `diagnose` so the go/no-go number cannot mean
 * two different things in two reports.
 *
 * Two corrections live here, both learned the hard way on a real 1045-image
 * catalog that reported 0.34 skill and had roughly 0.02:
 *
 * 1. **The baseline is measured in delta space.** "Apply my average edit" is the
 *    photographer's average *move*, decoded per image — not the average absolute
 *    value. For a slider the two are identical (neutral is 0), but for white
 *    balance, anchored on the as-shot temperature, averaging absolute Kelvin
 *    charges the baseline with the spread of the anchor instead of the spread of
 *    the edit. That handed a 100% skill to a parameter the exporter had never
 *    once read.
 *
 * 2. **Folds are grouped by capture session.** A catalog is not i.i.d.: a shoot
 *    is dozens of near-identical frames, routinely edited by pasting settings
 *    across the whole take. Splitting at random puts a frame's twin in the
 *    training set, and the model scores itself on photographs it has effectively
 *    already seen. Holding whole folders out is the only split that answers the
 *    question the tool exists to answer — "a shoot I have never touched".
 *
 * Both numbers are reported. The grouped one is the gate; the random one is a
 * legitimate second scenario (finishing a shoot already under way), and the gap
 * between them is the leakage meter.
 */
import { decodeDelta, type AsShotMeta, type DevelopParam } from '../develop/schema.js';
import { buildNormalEquations, solveRidge, predictStd } from './regress.js';
import { dot } from '../math/linalg.js';

/**
 * Ridge strengths tried, in **per-sample** units (see `NormalEquations.sw`).
 *
 * λ here is the shrinkage a standardized column actually gets — roughly a factor
 * 1/(1+λ) on its coefficient — so the grid means the same thing on a 40-image
 * catalog and a 4000-image one. The old grid was in raw XᵀX units, which made it
 * depend on the catalog size: at n=428 it spanned 0.23 to 70 in these units, and
 * every parameter that landed at the top was emitting a constant while still
 * being reported as a model.
 *
 * The bottom is 0.1 and not lower, which matters more than it looks. λ is
 * re-selected inside every outer fold of the gate, on a couple of dozen shoots;
 * a grid that reaches down to 0.01 offers that noisy inner search a value where
 * the fit blows up (level Contrast scores −31% there against +21% at 0.3), and
 * one fold picking it is enough to sink the honest score for the whole parameter.
 * Nothing measured on the reference catalog wants less shrinkage than 0.1, so the
 * range below it is all risk and no reach.
 */
export const LAMBDA_GRID = [0.1, 0.3, 1, 3, 10, 30, 100];
export const EPS = 1e-6;

/**
 * How far the de-shrinking slope may go.
 *
 * Below 1 it is left alone — a slope under 1 means the model *over*-reached and
 * shrinking further is correct. Above, it is capped: the slope is one scalar off
 * held-out rows, and a parameter whose predictions barely move can produce an
 * enormous ratio out of noise. Three times is already a large correction to admit
 * to.
 *
 * The cap has to be applied in the λ search as well as at shipping time, or the
 * two disagree about what is being chosen: an enormously shrunk fit looks fine to
 * a search that may rescale it by twenty and is useless once the rescaling is
 * limited to three. That mismatch gated Highlights outright the first time.
 */
export const MAX_RESPONSE = 3;
export const clampResponse = (v: number, max: number = MAX_RESPONSE): number =>
  Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : 1;

/** How held-out folds are drawn. */
export type GroupBy = 'folder' | 'none';
export const GROUP_BY_MODES: GroupBy[] = ['folder', 'none'];

export interface EvalRow {
  x: number[];
  /** Target deltas, in the schema's delta space. */
  deltas: number[];
  /** The same targets as absolute crs values — what the MAE is measured in. */
  abs: number[];
  meta: AsShotMeta;
  /** Session key: photographs sharing one belong to the same fold. */
  group: string;
  /**
   * Importance in the *fit*, defaulting to 1.
   *
   * Never in the score. A weight says "this photograph is worth paying more
   * attention to", and letting it into the held-out error would let the same
   * choice that emphasized a row also decide how well the model did on it —
   * which is how a skill number stops being comparable to the one before it.
   * Weights change the model; the gate keeps measuring it the way it always did.
   */
  weight?: number;
  /**
   * Stable identity of the photograph this row came from.
   *
   * Only used to recognise that two calls are describing the *same* training set,
   * so a fold-local projection can be fitted once instead of once per parameter
   * bucket per scoring pass. Absent ⇒ no caching, which is correct but slow.
   */
  id?: number;
  /**
   * A known per-parameter delta this row's prediction is *added to*, in delta
   * space. Absent for an ordinary fit.
   *
   * This is what lets the frame head be scored honestly. Its target is a
   * deviation from the shoot's own level, so "did it help" is only answerable
   * against that level: the baseline becomes `decode(offset)` — the right answer
   * for the shoot with no per-frame modulation at all — and the model becomes
   * `decode(offset + prediction)`. Both land in the absolute crs units the
   * photographer sees, so the number is comparable with every other skill here.
   */
  offset?: number[];
}

/** Per-parameter held-out statistics under one fold policy. */
export interface ParamStats {
  modelMae: number;
  baselineMae: number;
  skill: number;
  /**
   * The same skill for the output as it actually ships — de-shrunk by
   * {@link response}. Filled by the λ search, which *selects* on it; absent from
   * the gate pass, which reports the raw number instead.
   */
  shippedSkill?: number;
  /**
   * Held-out slope of the truth on the prediction — the de-shrinking factor.
   *
   * Ridge returns a conditional mean, and a conditional mean estimated through
   * heavy shrinkage is systematically *under-dispersed*: it lands on the right
   * side of the average but nowhere near far enough. Measured on the reference
   * catalog, Highlights moved by a standard deviation of 2.3 points inside a
   * shoot where the photographer moved it by 15.3. That is the difference between
   * a prediction and a default.
   *
   * The correction is the ordinary regression-dilution one: regress the true
   * target on the model's own held-out output, and the slope is how much the
   * output should have moved. Above 1 means over-shrunk. It is *not* a free
   * ride — it scales the errors up too, and a model with no signal gets a slope
   * near 0, so it cannot manufacture response where there is none. Zero when
   * there is no held-out evidence.
   */
  response: number;
  /**
   * Spread of the same skill computed fold by fold — the error bar on the number
   * to its left.
   *
   * Without it a single per-parameter figure invites a conclusion it cannot
   * support. Measured on the reference catalog by repeating the whole evaluation
   * over 12 independent session→fold shuffles, `Shadows2012` moved between −5%
   * and +14% with no change to the model at all, which read as a regression the
   * first time it came out low. Seven parameters really did improve there and
   * none really got worse; the "one went up, another went down" pattern was
   * almost entirely this. Zero when there is no per-fold evidence.
   */
  skillSd: number;
}

/**
 * A feature transform fitted on a fold's *training* rows, then applied to every
 * row of that fold.
 *
 * Exists so a learned projection (the embedding PCA) is refitted inside each
 * fold instead of once over everything. It never sees a target, but a projection
 * chosen with the held-out fold in hand still flatters the score it then
 * produces — the same reason λ is re-selected per fold.
 */
export type RowTransform = (train: EvalRow[]) => (x: number[]) => number[];

const IDENTITY_TRANSFORM = (x: number[]): number[] => x;

export interface ColStats { mean: number[]; std: number[] }

export function columnStats(rows: number[][]): ColStats {
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

export const standardize = (row: number[], s: ColStats): number[] => row.map((v, j) => (v - s.mean[j]!) / s.std[j]!);

export function shuffled<T>(items: T[], seed = 12345): T[] {
  const a = items.slice();
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (1103515245 * s + 12345) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// The fold policy and the session-context feature must agree on what a session
// IS, or a shoot could be held out under one definition and described under
// another. One definition, re-exported for callers that only import from here.
export { sessionKey } from '../develop/session.js';

/**
 * Assign each row to a fold. Under `folder`, whole sessions land in the same
 * fold (largest first, always into the currently lightest fold) so no shoot is
 * split across the train/validation boundary. Under `none`, plain shuffled
 * round-robin — the leakage-prone split, kept for comparison.
 */
export function assignFolds(rows: EvalRow[], folds: number, groupBy: GroupBy): number[] {
  if (groupBy === 'none') {
    const order = shuffled(rows.map((_, i) => i));
    const fold = new Array<number>(rows.length).fill(0);
    order.forEach((rowIdx, i) => { fold[rowIdx] = i % folds; });
    return fold;
  }
  const byGroup = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const bucket = byGroup.get(r.group) ?? [];
    bucket.push(i);
    byGroup.set(r.group, bucket);
  });
  const load = new Array<number>(folds).fill(0);
  const fold = new Array<number>(rows.length).fill(0);
  for (const [, idxs] of [...byGroup.entries()].sort((a, b) => b[1].length - a[1].length)) {
    let target = 0;
    for (let k = 1; k < folds; k++) if (load[k]! < load[target]!) target = k;
    for (const i of idxs) fold[i] = target;
    load[target]! += idxs.length;
  }
  return fold;
}

/**
 * Targets that never move across the whole catalog.
 *
 * A constant is predicted perfectly by any model, so scoring it is meaningless —
 * and a target that is constant because the exporter failed to read it looks
 * exactly like one the photographer never touched. Flag them, keep them out of
 * the headline number, and let the report say so.
 */
export function degenerateTargets(rows: EvalRow[], paramCount: number): boolean[] {
  const out = new Array<boolean>(paramCount).fill(false);
  if (rows.length === 0) return out;
  for (let k = 0; k < paramCount; k++) {
    let mean = 0;
    for (const r of rows) mean += r.deltas[k]!;
    mean /= rows.length;
    let variance = 0;
    for (const r of rows) { const d = r.deltas[k]! - mean; variance += d * d; }
    out[k] = Math.sqrt(variance / rows.length) < 1e-9;
  }
  return out;
}

/**
 * k-fold CV over the whole λ grid at once → per-λ, per-parameter statistics.
 *
 * The model is compared against "apply my average edit": the mean target *delta*
 * over the training fold, decoded back to absolute units for each validation
 * image. Both sides of the ratio are therefore measured in the same absolute
 * crs units the photographer would see.
 *
 * Each λ is scored twice: as the ridge fit comes out, and after the de-shrinking
 * slope that will be applied to it. The second number is the one λ is selected
 * on, and the distinction matters more than it sounds. Scored on raw MAE this
 * search has a systematic preference for the flattest model it is offered — a
 * shrunk conditional mean has the lowest error *because* it barely moves — which
 * is how a slider ends up at the same value on a backlit frame and one in open
 * shade. Once the output is rescaled to the amplitude the evidence supports, MAE
 * stops rewarding timidity and starts rewarding a prediction that tracks.
 */
export function crossValidate(
  rows: EvalRow[],
  params: DevelopParam[],
  options: { folds: number; groupBy: GroupBy; grid?: number[]; transform?: RowTransform; maxResponse?: number },
): Map<number, ParamStats[]> {
  const grid = options.grid ?? LAMBDA_GRID;
  const P = params.length;
  const fold = assignFolds(rows, options.folds, options.groupBy);
  const baseErr = new Array<number>(P).fill(0);
  // Held-out output per λ, centered on its own fold's constant, plus that
  // constant — kept so the de-shrinking slope can be measured and applied
  // without a second pass over the folds.
  const centered = new Map<number, number[][]>(grid.map((l) => [l, rows.map(() => new Array<number>(P).fill(0))]));
  const anchor = rows.map(() => new Array<number>(P).fill(0));
  const scored = rows.map(() => false);
  let counted = 0;

  for (let f = 0; f < options.folds; f++) {
    const trainIdx: number[] = [];
    const valIdx: number[] = [];
    rows.forEach((_, i) => (fold[i] === f ? valIdx : trainIdx).push(i));
    if (trainIdx.length < 2 || valIdx.length === 0) continue;
    const train = trainIdx.map((i) => rows[i]!);

    const apply = options.transform ? options.transform(train) : IDENTITY_TRANSFORM;
    const trainX = train.map((r) => apply(r.x));
    const fs = columnStats(trainX);
    const ds = columnStats(train.map((r) => r.deltas));
    const ne = buildNormalEquations(trainX.map((x) => standardize(x, fs)), train.map((r) => standardize(r.deltas, ds)), train.map((r) => r.weight ?? 1));

    // "Apply my average edit", in delta space — on top of whatever this row
    // already knows (see EvalRow.offset; zero for an ordinary fit).
    const meanDelta = new Array<number>(P).fill(0);
    for (const r of train) for (let k = 0; k < P; k++) meanDelta[k]! += r.deltas[k]!;
    for (let k = 0; k < P; k++) meanDelta[k]! /= train.length;
    for (const i of valIdx) {
      const r = rows[i]!;
      scored[i] = true;
      for (let k = 0; k < P; k++) {
        anchor[i]![k] = meanDelta[k]!;
        baseErr[k]! += Math.abs(decodeDelta(params[k]!, (r.offset?.[k] ?? 0) + meanDelta[k]!, r.meta) - r.abs[k]!);
      }
    }
    counted += valIdx.length;

    const valStd = valIdx.map((i) => standardize(apply(rows[i]!.x), fs));
    for (const lambda of grid) {
      const { weights, bias } = solveRidge(ne, lambda);
      const store = centered.get(lambda)!;
      valIdx.forEach((i, j) => {
        const predStd = predictStd(weights, bias, valStd[j]!);
        for (let k = 0; k < P; k++) {
          store[i]![k] = predStd[k]! * ds.std[k]! + ds.mean[k]! - meanDelta[k]!;
        }
      });
    }
  }

  const n = Math.max(1, counted);
  const out = new Map<number, ParamStats[]>();
  for (const lambda of grid) {
    const store = centered.get(lambda)!;
    out.set(lambda, params.map((param, k) => {
      // Slope of the truth on the (centered) prediction: how far the output
      // should have moved, given how far it did move.
      let sp = 0, sy = 0, spp = 0, spy = 0;
      for (let i = 0; i < rows.length; i++) {
        if (!scored[i]) continue;
        const c = store[i]![k]!;
        const y = rows[i]!.deltas[k]! - anchor[i]![k]!;
        sp += c; sy += y; spp += c * c; spy += c * y;
      }
      const varP = spp / n - (sp / n) ** 2;
      const covPY = spy / n - (sp / n) * (sy / n);
      const slope = clampResponse(varP > EPS ? covPY / varP : 0, options.maxResponse);

      let modelErr = 0;
      let shippedErr = 0;
      for (let i = 0; i < rows.length; i++) {
        if (!scored[i]) continue;
        const r = rows[i]!;
        const off = (r.offset?.[k] ?? 0) + anchor[i]![k]!;
        const c = store[i]![k]!;
        modelErr += Math.abs(decodeDelta(param, off + c, r.meta) - r.abs[k]!);
        shippedErr += Math.abs(decodeDelta(param, off + slope * c, r.meta) - r.abs[k]!);
      }
      const modelMae = modelErr / n;
      const shippedMae = shippedErr / n;
      const baselineMae = baseErr[k]! / n;
      return {
        modelMae,
        baselineMae,
        // No error bar: this pass only ever chooses λ, it is never reported.
        skillSd: 0,
        response: slope,
        skill: baselineMae > EPS ? 1 - modelMae / baselineMae : 0,
        shippedSkill: baselineMae > EPS ? 1 - shippedMae / baselineMae : 0,
      };
    }));
  }
  return out;
}

/**
 * Fold-by-fold held-out error for a per-parameter λ, accumulated into stats.
 *
 * `lambdasFor` is handed each fold's *training* rows and returns the λ vector to
 * fit them with. That indirection is the whole point: passing a fixed vector
 * measures a known model, while re-selecting inside the callback measures the
 * *procedure* that picks λ — and only the second one is honest about a search.
 */
/**
 * The two post-fit steps that turn a ridge output into what actually reaches the
 * sidecar: the gate, and the de-shrinking slope.
 *
 * Passing them here is what makes "shipped skill" a real measurement rather than
 * an estimate. Both are applied around the *training fold's* mean, which is the
 * value a suppressed parameter emits, so the arithmetic matches inference
 * exactly.
 */
export interface ShippedPolicy {
  /** Per-parameter de-shrinking factor; 1 leaves the head's output alone. */
  scale: number[];
  /** Per-parameter: emit the constant instead of the model's output. */
  suppress: boolean[];
}

/** The head's raw output put through its gate and its de-shrinking slope. */
function ship(raw: number, mean: number, policy: ShippedPolicy | undefined, k: number): number {
  if (!policy) return raw;
  if (policy.suppress[k]) return mean;
  return mean + (policy.scale[k] ?? 1) * (raw - mean);
}

function accumulateFolds(
  rows: EvalRow[],
  params: DevelopParam[],
  options: { folds: number; groupBy: GroupBy; transform?: RowTransform; shipped?: ShippedPolicy; maxResponse?: number },
  lambdasFor: (train: EvalRow[]) => number[],
): ParamStats[] {
  const P = params.length;
  const fold = assignFolds(rows, options.folds, options.groupBy);
  const modelErr = new Array<number>(P).fill(0);
  const baseErr = new Array<number>(P).fill(0);
  // The same two errors kept fold by fold, so the reported skill can carry the
  // spread it was drawn from rather than pretending to be a point estimate.
  const perFold: { model: number[]; base: number[] }[] = [];
  // Held-out (prediction, truth) pairs in delta space, pooled across folds, for
  // the de-shrinking slope. Accumulated as sums so nothing is kept per row.
  const pair = { sp: new Array<number>(P).fill(0), sy: new Array<number>(P).fill(0), spp: new Array<number>(P).fill(0), spy: new Array<number>(P).fill(0) };
  let counted = 0;

  for (let f = 0; f < options.folds; f++) {
    const train = rows.filter((_, i) => fold[i] !== f);
    const val = rows.filter((_, i) => fold[i] === f);
    if (train.length < 2 || val.length === 0) continue;

    const foldErr = { model: new Array<number>(P).fill(0), base: new Array<number>(P).fill(0) };
    perFold.push(foldErr);
    const lambdas = lambdasFor(train);
    const apply = options.transform ? options.transform(train) : IDENTITY_TRANSFORM;
    const trainX = train.map((r) => apply(r.x));
    const valX = val.map((r) => apply(r.x));
    const fs = columnStats(trainX);
    const ds = columnStats(train.map((r) => r.deltas));
    const ne = buildNormalEquations(trainX.map((x) => standardize(x, fs)), train.map((r) => standardize(r.deltas, ds)), train.map((r) => r.weight ?? 1));

    // "Apply my average edit", in delta space (see the module header), on top of
    // whatever the row already knows (see EvalRow.offset).
    const meanDelta = new Array<number>(P).fill(0);
    for (const r of train) for (let k = 0; k < P; k++) meanDelta[k]! += r.deltas[k]!;
    for (let k = 0; k < P; k++) meanDelta[k]! /= train.length;
    for (const r of val) {
      for (let k = 0; k < P; k++) {
        const base = (r.offset?.[k] ?? 0) + meanDelta[k]!;
        const e = Math.abs(decodeDelta(params[k]!, base, r.meta) - r.abs[k]!);
        baseErr[k]! += e;
        foldErr.base[k]! += e;
      }
    }
    counted += val.length;

    // One Cholesky per *distinct* λ, not per parameter: the normal equations are
    // shared, so a per-parameter λ costs no more than the size of the grid.
    const valStd = valX.map((x) => standardize(x, fs));
    for (const lambda of new Set(lambdas)) {
      const { weights, bias } = solveRidge(ne, lambda);
      for (let k = 0; k < P; k++) {
        if (lambdas[k] !== lambda) continue;
        for (let i = 0; i < val.length; i++) {
          const fitted = (dot(weights[k]!, valStd[i]!) + bias[k]!) * ds.std[k]! + ds.mean[k]!;
          const raw = ship(fitted, meanDelta[k]!, options.shipped, k);
          const delta = (val[i]!.offset?.[k] ?? 0) + raw;
          const e = Math.abs(decodeDelta(params[k]!, delta, val[i]!.meta) - val[i]!.abs[k]!);
          modelErr[k]! += e;
          foldErr.model[k]! += e;
          // Delta space, model output against target: the slope between them is
          // what the shrinkage cost in reach.
          const y = val[i]!.deltas[k]!;
          pair.sp[k]! += raw;
          pair.sy[k]! += y;
          pair.spp[k]! += raw * raw;
          pair.spy[k]! += raw * y;
        }
      }
    }
  }

  const n = Math.max(1, counted);
  return params.map((_, k) => {
    const modelMae = modelErr[k]! / n;
    const baselineMae = baseErr[k]! / n;
    const skill = baselineMae > EPS ? 1 - modelMae / baselineMae : 0;
    // The same skill, fold by fold: how far this number moves when the held-out
    // shoots change is the only honest way to read a single-run figure.
    const perFoldSkill = perFold
      .filter((f) => f.base[k]! > EPS)
      .map((f) => 1 - f.model[k]! / f.base[k]!);
    let skillSd = 0;
    if (perFoldSkill.length > 1) {
      const mean = perFoldSkill.reduce((s, v) => s + v, 0) / perFoldSkill.length;
      skillSd = Math.sqrt(perFoldSkill.reduce((s, v) => s + (v - mean) ** 2, 0) / perFoldSkill.length);
    }
    // Centered slope of truth on prediction over the pooled held-out rows. One
    // scalar per parameter from a few hundred points, so the reuse of the same
    // rows that produced the skill is a negligible optimism — and the alternative,
    // a second nested layer of folds, costs more than the number is worth.
    const varP = pair.spp[k]! / n - (pair.sp[k]! / n) ** 2;
    const covPY = pair.spy[k]! / n - (pair.sp[k]! / n) * (pair.sy[k]! / n);
    const response = clampResponse(varP > EPS ? covPY / varP : 0, options.maxResponse);
    return { modelMae, baselineMae, skill, skillSd, response };
  });
}

/**
 * The λ each parameter is best fitted with, chosen by held-out skill.
 *
 * One λ for the whole vector is the wrong shape for this problem: exposure and
 * the HSL sliders do not want the same amount of shrinkage, and a shared λ is
 * picked by an average that the unpredictable majority dominates. On a real
 * catalog that pinned λ to the top of the grid and collapsed *every* parameter
 * onto the photographer's mean — which is exactly what a flat, "same settings
 * for every photo" prediction looks like from the outside.
 *
 * Selected on the *de-shrunk* skill — what the parameter will actually ship —
 * rather than on the raw ridge output. See {@link crossValidate}.
 *
 * Ties go to the larger λ: same held-out evidence, less variance.
 */
export function selectLambdas(
  rows: EvalRow[],
  params: DevelopParam[],
  options: { folds: number; groupBy: GroupBy; grid?: number[]; transform?: RowTransform; maxResponse?: number },
): number[] {
  const grid = options.grid ?? LAMBDA_GRID;
  const cv = crossValidate(rows, params, options);
  return params.map((_, k) => {
    let best = grid[0]!;
    let bestSkill = -Infinity;
    for (const lambda of grid) {
      const stats = cv.get(lambda)![k]!;
      const skill = stats.shippedSkill ?? stats.skill;
      if (skill >= bestSkill - EPS) {
        bestSkill = Math.max(bestSkill, skill);
        best = lambda;
      }
    }
    return best;
  });
}

/** Held-out stats for a λ vector fixed in advance (no search happens here). */
export function evaluateWithLambda(
  rows: EvalRow[],
  params: DevelopParam[],
  options: { folds: number; groupBy: GroupBy; transform?: RowTransform; shipped?: ShippedPolicy; maxResponse?: number },
  lambdas: number[],
): ParamStats[] {
  return accumulateFolds(rows, params, options, () => lambdas);
}

/**
 * The model's own held-out output per row, in delta space — no scoring.
 *
 * Exists so one head's prediction can become another's starting point. The frame
 * head's honest end-to-end number is what it adds to the level the model would
 * *really* have produced for a shoot it has never seen, and that level has to be
 * held out under the same fold assignment or the two are not comparable.
 */
export function heldOutDeltas(
  rows: EvalRow[],
  paramCount: number,
  options: { folds: number; groupBy: GroupBy; transform?: RowTransform; shipped?: ShippedPolicy; maxResponse?: number },
  lambdas: number[],
): number[][] {
  const P = paramCount;
  const fold = assignFolds(rows, options.folds, options.groupBy);
  const out = rows.map(() => new Array<number>(P).fill(0));

  for (let f = 0; f < options.folds; f++) {
    const trainIdx: number[] = [];
    const valIdx: number[] = [];
    rows.forEach((_, i) => (fold[i] === f ? valIdx : trainIdx).push(i));
    if (trainIdx.length < 2 || valIdx.length === 0) continue;

    const train = trainIdx.map((i) => rows[i]!);
    const apply = options.transform ? options.transform(train) : IDENTITY_TRANSFORM;
    const trainX = train.map((r) => apply(r.x));
    const fs = columnStats(trainX);
    const ds = columnStats(train.map((r) => r.deltas));
    const ne = buildNormalEquations(
      trainX.map((x) => standardize(x, fs)),
      train.map((r) => standardize(r.deltas, ds)),
      train.map((r) => r.weight ?? 1),
    );
    const meanDelta = new Array<number>(P).fill(0);
    for (const r of train) for (let k = 0; k < P; k++) meanDelta[k]! += r.deltas[k]!;
    for (let k = 0; k < P; k++) meanDelta[k]! /= train.length;

    const valStd = valIdx.map((i) => standardize(apply(rows[i]!.x), fs));
    for (const lambda of new Set(lambdas)) {
      const { weights, bias } = solveRidge(ne, lambda);
      for (let k = 0; k < P; k++) {
        if (lambdas[k] !== lambda) continue;
        valIdx.forEach((i, j) => {
          const fitted = (dot(weights[k]!, valStd[j]!) + bias[k]!) * ds.std[k]! + ds.mean[k]!;
          out[i]![k] = ship(fitted, meanDelta[k]!, options.shipped, k);
        });
      }
    }
  }
  return out;
}

/**
 * Held-out stats for the whole "choose λ per parameter, then fit" procedure.
 *
 * λ is re-selected on an inner CV over each outer fold's training rows, so the
 * validation fold never took part in the choice. Selecting on the same folds you
 * then report would hand every parameter the best of |grid| tries and quietly
 * inflate the gate — with ~90 parameters and a gate threshold of a couple of
 * percent, that is enough noise to let unpredictable sliders through as if the
 * model had learned them.
 */
export function nestedEvaluate(
  rows: EvalRow[],
  params: DevelopParam[],
  options: { folds: number; groupBy: GroupBy; grid?: number[]; innerFolds?: number; transform?: RowTransform },
): ParamStats[] {
  const innerFolds = options.innerFolds ?? options.folds;
  const grid = options.grid ?? LAMBDA_GRID;
  // Too little data to select on: fall back to the strongest shrinkage in the
  // grid rather than the weakest, so a fold with no evidence cannot invent any.
  const noEvidence = grid[grid.length - 1]!;
  return accumulateFolds(rows, params, options, (train) =>
    train.length >= innerFolds * 4
      ? selectLambdas(train, params, {
          folds: innerFolds,
          groupBy: options.groupBy,
          grid,
          transform: options.transform,
        })
      : params.map(() => noEvidence),
  );
}

/**
 * The headline number: skill over the image-dependent parameters, weighted.
 *
 * Style constants (HSL, colour grading) are expected to collapse to the
 * photographer's mean and carry little weight; degenerate targets are excluded
 * outright, since "predicted a constant perfectly" is not skill.
 */
export function weightedSkill(
  stats: ParamStats[],
  params: DevelopParam[],
  degenerate: boolean[],
): number | null {
  let wsum = 0;
  let acc = 0;
  for (let k = 0; k < params.length; k++) {
    const param = params[k]!;
    if (param.weight < 1.5) continue;
    if (degenerate[k]) continue;
    const s = stats[k]!;
    if (s.baselineMae < EPS) continue;
    wsum += param.weight;
    acc += param.weight * s.skill;
  }
  return wsum > 0 ? acc / wsum : null;
}
