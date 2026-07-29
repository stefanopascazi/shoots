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

export const LAMBDA_GRID = [100, 300, 1000, 3000, 10000, 30000];
export const EPS = 1e-6;

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
}

/** Per-parameter held-out statistics under one fold policy. */
export interface ParamStats {
  modelMae: number;
  baselineMae: number;
  skill: number;
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
 */
export function crossValidate(
  rows: EvalRow[],
  params: DevelopParam[],
  options: { folds: number; groupBy: GroupBy; grid?: number[]; transform?: RowTransform },
): Map<number, ParamStats[]> {
  const grid = options.grid ?? LAMBDA_GRID;
  const P = params.length;
  const fold = assignFolds(rows, options.folds, options.groupBy);
  const modelErr = new Map<number, number[]>(grid.map((l) => [l, new Array<number>(P).fill(0)]));
  const baseErr = new Array<number>(P).fill(0);
  let counted = 0;

  for (let f = 0; f < options.folds; f++) {
    const train = rows.filter((_, i) => fold[i] !== f);
    const val = rows.filter((_, i) => fold[i] === f);
    if (train.length < 2 || val.length === 0) continue;

    const apply = options.transform ? options.transform(train) : IDENTITY_TRANSFORM;
    const trainX = train.map((r) => apply(r.x));
    const valX = val.map((r) => apply(r.x));
    const fs = columnStats(trainX);
    const ds = columnStats(train.map((r) => r.deltas));
    const ne = buildNormalEquations(trainX.map((x) => standardize(x, fs)), train.map((r) => standardize(r.deltas, ds)));

    // "Apply my average edit", in delta space.
    const meanDelta = new Array<number>(P).fill(0);
    for (const r of train) for (let k = 0; k < P; k++) meanDelta[k]! += r.deltas[k]!;
    for (let k = 0; k < P; k++) meanDelta[k]! /= train.length;
    for (const r of val) {
      for (let k = 0; k < P; k++) {
        baseErr[k]! += Math.abs(decodeDelta(params[k]!, meanDelta[k]!, r.meta) - r.abs[k]!);
      }
    }
    counted += val.length;

    const valStd = valX.map((x) => standardize(x, fs));
    for (const lambda of grid) {
      const { weights, bias } = solveRidge(ne, lambda);
      const err = modelErr.get(lambda)!;
      val.forEach((r, i) => {
        const predStd = predictStd(weights, bias, valStd[i]!);
        for (let k = 0; k < P; k++) {
          const delta = predStd[k]! * ds.std[k]! + ds.mean[k]!;
          err[k]! += Math.abs(decodeDelta(params[k]!, delta, r.meta) - r.abs[k]!);
        }
      });
    }
  }

  const n = Math.max(1, counted);
  const out = new Map<number, ParamStats[]>();
  for (const lambda of grid) {
    const err = modelErr.get(lambda)!;
    out.set(lambda, params.map((_, k) => {
      const modelMae = err[k]! / n;
      const baselineMae = baseErr[k]! / n;
      return {
        modelMae,
        baselineMae,
        // Only ever used to choose λ, never reported — no error bar needed.
        skillSd: 0,
        skill: baselineMae > EPS ? 1 - modelMae / baselineMae : 0,
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
function accumulateFolds(
  rows: EvalRow[],
  params: DevelopParam[],
  options: { folds: number; groupBy: GroupBy; transform?: RowTransform },
  lambdasFor: (train: EvalRow[]) => number[],
): ParamStats[] {
  const P = params.length;
  const fold = assignFolds(rows, options.folds, options.groupBy);
  const modelErr = new Array<number>(P).fill(0);
  const baseErr = new Array<number>(P).fill(0);
  // The same two errors kept fold by fold, so the reported skill can carry the
  // spread it was drawn from rather than pretending to be a point estimate.
  const perFold: { model: number[]; base: number[] }[] = [];
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
    const ne = buildNormalEquations(trainX.map((x) => standardize(x, fs)), train.map((r) => standardize(r.deltas, ds)));

    // "Apply my average edit", in delta space (see the module header).
    const meanDelta = new Array<number>(P).fill(0);
    for (const r of train) for (let k = 0; k < P; k++) meanDelta[k]! += r.deltas[k]!;
    for (let k = 0; k < P; k++) meanDelta[k]! /= train.length;
    for (const r of val) {
      for (let k = 0; k < P; k++) {
        const e = Math.abs(decodeDelta(params[k]!, meanDelta[k]!, r.meta) - r.abs[k]!);
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
          const delta = (dot(weights[k]!, valStd[i]!) + bias[k]!) * ds.std[k]! + ds.mean[k]!;
          const e = Math.abs(decodeDelta(params[k]!, delta, val[i]!.meta) - val[i]!.abs[k]!);
          modelErr[k]! += e;
          foldErr.model[k]! += e;
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
    return { modelMae, baselineMae, skill, skillSd };
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
 * Ties go to the larger λ: same held-out evidence, less variance.
 */
export function selectLambdas(
  rows: EvalRow[],
  params: DevelopParam[],
  options: { folds: number; groupBy: GroupBy; grid?: number[]; transform?: RowTransform },
): number[] {
  const grid = options.grid ?? LAMBDA_GRID;
  const cv = crossValidate(rows, params, options);
  return params.map((_, k) => {
    let best = grid[0]!;
    let bestSkill = -Infinity;
    for (const lambda of grid) {
      const skill = cv.get(lambda)![k]!.skill;
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
  options: { folds: number; groupBy: GroupBy; transform?: RowTransform },
  lambdas: number[],
): ParamStats[] {
  return accumulateFolds(rows, params, options, () => lambdas);
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
