/**
 * Anchored prediction: a slider as a *correction toward a target*.
 *
 * The two heads learn `slider = f(features)` as a shrunk regression, so their
 * output is a conditional mean — timid everywhere, and timidest exactly where the
 * correction needs to be large. A frame needing −1.5 stops of exposure comes back
 * with −0.14. De-shrinking cannot fix that: it rescales a prediction, it cannot
 * make a flat one point somewhere, and on the reference catalog `Exposure2012`'s
 * frame head pins itself to whatever de-shrinking ceiling it is offered because
 * the slope is `cov/var` over an output that barely moves.
 *
 * This is the other formulation:
 *
 *     slider = ȳ + gain · (x − x̄)
 *
 * `x` is one measured property of *this* photograph, `x̄` and `ȳ` are the
 * photographer's own averages, and `gain` is the **unshrunk** slope. Nothing here
 * is regularised toward zero, which is the entire point: a frame far from the
 * photographer's typical scene gets a proportionally large correction by
 * arithmetic, without the fit having ever seen a frame that extreme.
 *
 * It buys that by being worse on average — an unshrunk slope always is, because
 * the shrunk one is the MAE-optimal choice. That trade is measured per parameter
 * before it is taken, and it is measured on the frames it is meant to serve; see
 * {@link fitAnchor} and `tools/anchor-probe`.
 */
import type { AsShotMeta, DevelopParam } from '../develop/schema.js';

/** One slider's anchor: which scene property it corrects against. */
export interface AnchorSpec {
  /** Name in `COLOR_FEATURE_NAMES`. */
  feature: string;
  /**
   * Read the feature in log2 before measuring the gap.
   *
   * For anything that behaves multiplicatively — a stop of exposure is a
   * doubling — the gap has to be measured in the space the slider moves in, or
   * one gain cannot describe a dark frame and a bright one at once.
   */
  log2?: boolean;
}

/**
 * Sliders worth anchoring, and against what.
 *
 * Deliberately short. Measured over 553 edits with whole shoots held out, only
 * these two beat the shrunk fit on the frames that carry the largest corrections
 * — `Highlights2012` on both the average and the tail (0.172/0.177 against
 * 0.049/0.036), `Exposure2012` on the tail alone (0.121 against 0.012, while
 * losing on the average). Everything else measured at or below zero: `Whites`,
 * `Shadows`, `Blacks`, `Contrast`, `Vibrance`, `Saturation`, `Clarity` and
 * `Texture` are not corrections toward a scene-derived target in this catalog,
 * and asserting otherwise is how hand-rolled photometric priors scored negative
 * the first time they were tried.
 */
export const ANCHORS: Record<string, AnchorSpec> = {
  Exposure2012: { feature: 'lumaMean', log2: true },
  Highlights2012: { feature: 'lumaP99' },
};

/** A fitted anchor, stored in the profile and replayed at inference. */
export interface AnchorModel extends AnchorSpec {
  /** Index into the dataset's colour feature block. */
  index: number;
  xbar: number;
  ybar: number;
  /** Unshrunk slope, slider units per unit of the anchor. */
  gain: number;
  /** Held-out skill on the worst fifth of frames — why this was kept. */
  tailSkill: number;
  /** Held-out skill over everything, for the record. It is usually worse. */
  skill: number;
}

const EPS = 1e-9;

const meanOf = (a: readonly number[]): number => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const sdOf = (a: readonly number[]): number => {
  const m = meanOf(a);
  return Math.sqrt(meanOf(a.map((v) => (v - m) ** 2)));
};

/** Read one anchor's scene property from a photograph's colour features. */
export function anchorValue(model: AnchorSpec & { index: number }, colour: readonly number[]): number | null {
  const raw = colour[model.index];
  if (raw === undefined || !Number.isFinite(raw)) return null;
  if (!model.log2) return raw;
  return raw > EPS ? Math.log2(raw) : null;
}

export interface AnchorSample {
  /** The anchor's scene property, already log2'd where the spec asks for it. */
  x: number;
  /** The absolute slider value the photographer chose. */
  y: number;
  /** Session key: whole shoots are held out together. */
  group: string;
}

/** Unshrunk least squares — the gain, deliberately un-regularised. */
function slope(rows: readonly AnchorSample[]): number {
  const xs = rows.map((r) => r.x);
  const ys = rows.map((r) => r.y);
  const xbar = meanOf(xs);
  const ybar = meanOf(ys);
  let num = 0;
  let den = 0;
  for (const r of rows) {
    num += (r.x - xbar) * (r.y - ybar);
    den += (r.x - xbar) ** 2;
  }
  return den > EPS ? num / den : 0;
}

export interface AnchorFit {
  model: AnchorModel;
  /** Whether the measurement says this anchor earns its place. */
  keep: boolean;
}

/**
 * Fit one anchor and decide whether it is worth shipping.
 *
 * The decision is made on the **tail** — the fifth of frames whose correction is
 * largest — and not on the average. Average MAE is the metric that prefers the
 * flat answer, so judging an anti-flatness mechanism by it would reject every
 * candidate by construction. A slider sitting at the photographer's mean on a
 * blown frame is useless at any MAE.
 */
export function fitAnchor(
  param: DevelopParam,
  spec: AnchorSpec,
  index: number,
  rows: readonly AnchorSample[],
  opts: { folds: number; shuffles: number },
): AnchorFit | null {
  if (rows.length < 60) return null;
  const ys = rows.map((r) => r.y);
  if (sdOf(ys) < EPS || sdOf(rows.map((r) => r.x)) < EPS) return null;

  const centre = meanOf(ys);
  const spread = ys.map((v) => Math.abs(v - centre)).sort((a, b) => a - b);
  const tailCut = spread[Math.floor(spread.length * 0.8)] ?? 0;
  const isTail = (r: AnchorSample): boolean => Math.abs(r.y - centre) >= tailCut;

  const groups = [...new Set(rows.map((r) => r.group))];
  const all: number[] = [];
  const tail: number[] = [];
  for (let s = 0; s < opts.shuffles; s++) {
    // Deterministic reshuffle of shoots into folds; the spread across them is
    // what stops a single lucky split from deciding this.
    let seed = (s * 7919 + 13) >>> 0;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const order = [...groups].sort(() => rnd() - 0.5);
    const foldOf = new Map(order.map((g, i) => [g, i % opts.folds]));
    for (let f = 0; f < opts.folds; f++) {
      const tr = rows.filter((r) => foldOf.get(r.group) !== f);
      const te = rows.filter((r) => foldOf.get(r.group) === f);
      if (tr.length < 20 || te.length === 0) continue;
      const g = slope(tr);
      const xb = meanOf(tr.map((r) => r.x));
      const yb = meanOf(tr.map((r) => r.y));
      const score = (pick: (r: AnchorSample) => boolean): number | null => {
        let model = 0;
        let base = 0;
        let n = 0;
        for (const r of te) {
          if (!pick(r)) continue;
          const clamped = Math.min(param.absMax, Math.max(param.absMin, yb + g * (r.x - xb)));
          model += Math.abs(clamped - r.y);
          base += Math.abs(yb - r.y);
          n++;
        }
        return n > 0 && base > EPS ? 1 - model / base : null;
      };
      const a = score(() => true);
      if (a !== null) all.push(a);
      const t = score(isTail);
      if (t !== null) tail.push(t);
    }
  }
  if (tail.length === 0) return null;

  const model: AnchorModel = {
    ...spec,
    index,
    xbar: meanOf(rows.map((r) => r.x)),
    ybar: meanOf(ys),
    gain: slope(rows),
    tailSkill: Math.round(meanOf(tail) * 1e4) / 1e4,
    skill: Math.round(meanOf(all) * 1e4) / 1e4,
  };
  // A positive tail skill by more than its own spread across reshuffles. The
  // spread is the same discipline BASELINE.md applies everywhere else: on a few
  // hundred frames a single per-parameter figure swings several points on its own.
  return { model, keep: meanOf(tail) > sdOf(tail) };
}

/** Replay a fitted anchor for one photograph. Null when it cannot be read. */
export function predictAnchor(
  param: DevelopParam,
  model: AnchorModel,
  colour: readonly number[],
  _meta: AsShotMeta,
): number | null {
  const x = anchorValue(model, colour);
  if (x === null) return null;
  const raw = model.ybar + model.gain * (x - model.xbar);
  return Math.min(param.absMax, Math.max(param.absMin, raw));
}
