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
 * Candidate anchors per slider: the scene properties each might be correcting.
 *
 * A list rather than one choice, because for most of these the plausible
 * property is not obvious — `Blacks2012` could be answering how much is already
 * crushed or how dark the bottom of the histogram sits, and only the measurement
 * separates them. The best candidate is picked on held-out tail skill and then
 * has to pass the stability test in {@link fitAnchor} regardless, so a slider
 * with no anchor at all is a perfectly ordinary outcome — most were, the first
 * time this was measured with a straight line.
 *
 * That first pass rejected everything but `Exposure2012` and `Highlights2012`,
 * and the rejection was partly an artefact of the shape: a single line has to
 * average "leave the acceptable frames alone" together with "go after the bad
 * one", and lands somewhere useless for both. `Exposure2012` scored −0.218 on
 * the average that way and +0.124 once it was allowed a dead zone. The others
 * are re-offered here on the same terms.
 *
 * Picking among two candidates on the same held-out folds that then report the
 * score is mildly optimistic. It is bounded by the stability test — the mean
 * across fold reshuffles has to clear its own spread — and two candidates is a
 * far smaller freedom than the seven dead-zone widths already selected nested.
 */
export const ANCHORS: Record<string, AnchorSpec[]> = {
  // Where the bulk of the histogram sits.
  Exposure2012: [{ feature: 'lumaMean', log2: true }, { feature: 'lumaMedian', log2: true }],
  // What is at risk at the top, and what is already gone.
  Highlights2012: [{ feature: 'lumaP99' }, { feature: 'clipHigh' }],
  Whites2012: [{ feature: 'clipHigh' }, { feature: 'lumaP99' }],
  // The same question at the bottom of the histogram.
  Shadows2012: [{ feature: 'lumaP01' }, { feature: 'shadowFloor' }],
  Blacks2012: [{ feature: 'clipShadow' }, { feature: 'lumaP01' }],
  // How much separation the frame already has.
  Contrast2012: [{ feature: 'lumaStd' }],
  // How much colour is already there — the relationship the feature masks were
  // hiding from the heads entirely until satMean was added to the presence set.
  Vibrance: [{ feature: 'satMean' }, { feature: 'satStd' }],
  Saturation: [{ feature: 'satMean' }, { feature: 'satStd' }],
  // How much local structure there is to push, and how much veil sits over it.
  Clarity2012: [{ feature: 'detailCoarse' }, { feature: 'detailFine' }, { feature: 'lumaStd' }, { feature: 'darkChannel' }],
  Texture: [{ feature: 'detailFine' }, { feature: 'detailCoarse' }, { feature: 'lumaStd' }],
  Dehaze: [{ feature: 'darkChannel' }, { feature: 'detailCoarse' }, { feature: 'satMean' }, { feature: 'lumaStd' }],
  ...curveAnchors(),
};

/**
 * Tone-curve knots, anchored on the histogram bin they sit over.
 *
 * A knot at input level L lifts or drops whatever tone is *at* L, so the
 * question it answers is how much of this photograph lives there — which is
 * exactly `lumaHist<n>` for the bin containing L, a feature that has existed in
 * the vector all along and was never offered to the curve. The knots were
 * predicted from the whole 50-column block instead, and every one of them came
 * back with a de-shrinking slope at or near zero: a constant curve, which is
 * what "the tone curve barely changes" looks like from the outside.
 *
 * `lumaMedian` rides along as the alternative reading — a knot may be answering
 * where the whole image sits rather than what is at its own level — and the tail
 * measurement picks between them per knot.
 */
function curveAnchors(): Record<string, AnchorSpec[]> {
  const out: Record<string, AnchorSpec[]> = {};
  const BINS = 16;
  for (const level of [0, 32, 64, 96, 128, 160, 192, 224, 255]) {
    const bin = Math.min(BINS - 1, Math.floor((level / 256) * BINS));
    out[`ToneCurvePoint${level}`] = [{ feature: `lumaHist${bin}` }, { feature: 'lumaMedian' }];
  }
  return out;
}

/**
 * A fitted anchor, stored in the profile and replayed at inference.
 *
 * The shape is a dead zone with a gain on each side:
 *
 *     gap   = x − x̄
 *     slider = ȳ + gain · max(0, gap − d) + gainBelow · min(0, gap + d)
 *
 * `d = 0` and `gainBelow = gain` reduce it to the plain line, so a profile
 * carrying neither field still replays exactly.
 *
 * The dead zone is the shape the measurement asked for. A single line fitted to
 * `Exposure2012` scored +0.151 on the tail and **−0.218 on the average**: too
 * steep for the frames that were already fine and too shallow for the ones that
 * were not. That is a photographer leaving an acceptable frame alone and going
 * after a bad one, which no straight line through the origin can be.
 *
 * The two gains are separate because over- and under-exposure are not the same
 * decision: a blown highlight is gone and gets pulled hard, a dark frame is
 * recoverable and carries noise, so the same distance from target does not buy
 * the same correction in each direction.
 */
export interface AnchorModel extends AnchorSpec {
  /** Index into the dataset's colour feature block. */
  index: number;
  xbar: number;
  ybar: number;
  /** Unshrunk slope above the dead zone, slider units per unit of the anchor. */
  gain: number;
  /** Slope below it. Absent ⇒ the same as {@link gain}. */
  gainBelow?: number;
  /** Half-width of the zone around x̄ where the slider does not move at all. */
  deadband?: number;
  /** Held-out skill on the worst fifth of frames — why this was kept. */
  tailSkill: number;
  /** Held-out skill over everything, for the record. It is usually worse. */
  skill: number;
}

/** The shape, in one place, so the fit and the inference cannot disagree. */
export function anchorApply(m: Pick<AnchorModel, 'xbar' | 'ybar' | 'gain' | 'gainBelow' | 'deadband'>, x: number): number {
  const gap = x - m.xbar;
  const d = m.deadband ?? 0;
  return m.ybar + m.gain * Math.max(0, gap - d) + (m.gainBelow ?? m.gain) * Math.min(0, gap + d);
}

/** Least squares for [intercept, gainAbove, gainBelow] at a fixed dead zone. */
function fitShape(rows: readonly AnchorSample[], xbar: number, d: number): { ybar: number; gain: number; gainBelow: number } {
  // 3x3 normal equations, solved by elimination. The two gain columns have
  // disjoint support but both overlap the intercept, so they cannot be fitted
  // independently.
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b = [0, 0, 0];
  for (const r of rows) {
    const gap = r.x - xbar;
    const v = [1, Math.max(0, gap - d), Math.min(0, gap + d)];
    for (let i = 0; i < 3; i++) {
      b[i]! += v[i]! * r.y;
      for (let j = 0; j < 3; j++) A[i]![j]! += v[i]! * v[j]!;
    }
  }
  // A touch of ridge on the gains only: a dead zone wide enough to empty one
  // side leaves that column singular, and 0 is the right answer there.
  A[1]![1]! += 1e-8;
  A[2]![2]! += 1e-8;
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[piv]![c]!)) piv = r;
    if (Math.abs(A[piv]![c]!) < 1e-12) continue;
    [A[c], A[piv]] = [A[piv]!, A[c]!];
    [b[c], b[piv]] = [b[piv]!, b[c]!];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = A[r]![c]! / A[c]![c]!;
      for (let k = c; k < 3; k++) A[r]![k]! -= f * A[c]![k]!;
      b[r]! -= f * b[c]!;
    }
  }
  const sol = [0, 1, 2].map((i) => (Math.abs(A[i]![i]!) > 1e-12 ? b[i]! / A[i]![i]! : 0));
  return { ybar: sol[0]!, gain: sol[1]!, gainBelow: sol[2]! };
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

/** Dead-zone half-widths tried, as multiples of the anchor's own spread. */
const DEADBAND_GRID = [0, 0.15, 0.3, 0.5, 0.75, 1, 1.5];

/** Held-out error of one shape over a subset. Null when the subset is empty. */
function scoreShape(
  param: DevelopParam,
  shape: { xbar: number; ybar: number; gain: number; gainBelow: number; deadband: number },
  test: readonly AnchorSample[],
  pick: (r: AnchorSample) => boolean,
): { skill: number } | null {
  let model = 0;
  let base = 0;
  let n = 0;
  for (const r of test) {
    if (!pick(r)) continue;
    const p = Math.min(param.absMax, Math.max(param.absMin, anchorApply(shape, r.x)));
    model += Math.abs(p - r.y);
    base += Math.abs(shape.ybar - r.y);
    n++;
  }
  return n > 0 && base > EPS ? { skill: 1 - model / base } : null;
}

/** Fit the shape at a given dead zone, on one training set. */
function shapeAt(rows: readonly AnchorSample[], d: number): { xbar: number; ybar: number; gain: number; gainBelow: number; deadband: number } {
  const xbar = meanOf(rows.map((r) => r.x));
  return { xbar, deadband: d, ...fitShape(rows, xbar, d) };
}

/** Deterministic fold assignment over whole shoots. */
function foldsOf(groups: readonly string[], folds: number, seed: number): Map<string, number> {
  let s = (seed * 7919 + 13) >>> 0;
  const rnd = (): number => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const order = [...new Set(groups)].sort(() => rnd() - 0.5);
  return new Map(order.map((g, i) => [g, i % folds]));
}

/**
 * Fit one anchor and decide whether it is worth shipping.
 *
 * The decision is made on the **tail** — the fifth of frames whose correction is
 * largest — and not on the average. Average MAE is the metric that prefers the
 * flat answer, so judging an anti-flatness mechanism by it would reject every
 * candidate by construction. A slider sitting at the photographer's mean on a
 * blown frame is useless at any MAE.
 *
 * The dead zone is chosen **inside** each outer fold, never on the split it is
 * then scored against. Seven candidate widths on a few dozen shoots is more than
 * enough freedom to manufacture a tail skill out of one lucky split.
 */
export function fitAnchor(
  param: DevelopParam,
  spec: AnchorSpec,
  index: number,
  rows: readonly AnchorSample[],
  opts: { folds: number; shuffles: number; maeAllowance: number },
): AnchorFit | null {
  if (rows.length < 60) return null;
  const ys = rows.map((r) => r.y);
  const xs = rows.map((r) => r.x);
  if (sdOf(ys) < EPS || sdOf(xs) < EPS) return null;

  const centre = meanOf(ys);
  const spread = ys.map((v) => Math.abs(v - centre)).sort((a, b) => a - b);
  const tailCut = spread[Math.floor(spread.length * 0.8)] ?? 0;
  const isTail = (r: AnchorSample): boolean => Math.abs(r.y - centre) >= tailCut;
  const grid = DEADBAND_GRID.map((f) => f * sdOf(xs));

  // Scores are pooled per *shuffle*, not per fold. A single fold's skill on a few
  // dozen shoots swings several points on its own — BASELINE.md says so for every
  // other number in this tool — so the fold is the wrong unit to measure
  // stability in. The shuffle mean is what has to be reliably positive.
  const all: number[] = [];
  const tail: number[] = [];
  const chosen: number[] = [];
  for (let s = 0; s < opts.shuffles; s++) {
    const foldAll: number[] = [];
    const foldTail: number[] = [];
    const foldOf = foldsOf(rows.map((r) => r.group), opts.folds, s + 1);
    for (let f = 0; f < opts.folds; f++) {
      const tr = rows.filter((r) => foldOf.get(r.group) !== f);
      const te = rows.filter((r) => foldOf.get(r.group) === f);
      if (tr.length < 40 || te.length === 0) continue;

      // Inner selection: the width is picked on the training shoots alone, on
      // the same tail criterion the outer score will use.
      const inner = foldsOf(tr.map((r) => r.group), opts.folds, s + 500 + f);
      let best = { d: grid[0]!, skill: -Infinity };
      for (const d of grid) {
        let acc = 0;
        let n = 0;
        for (let g = 0; g < opts.folds; g++) {
          const itr = tr.filter((r) => inner.get(r.group) !== g);
          const ite = tr.filter((r) => inner.get(r.group) === g);
          if (itr.length < 20 || ite.length === 0) continue;
          const sc = scoreShape(param, shapeAt(itr, d), ite, isTail);
          if (sc) { acc += sc.skill; n++; }
        }
        if (n > 0 && acc / n > best.skill) best = { d, skill: acc / n };
      }
      chosen.push(best.d);

      const shape = shapeAt(tr, best.d);
      const a = scoreShape(param, shape, te, () => true);
      if (a) foldAll.push(a.skill);
      const t = scoreShape(param, shape, te, isTail);
      if (t) foldTail.push(t.skill);
    }
    if (foldAll.length > 0) all.push(meanOf(foldAll));
    if (foldTail.length > 0) tail.push(meanOf(foldTail));
  }
  if (tail.length === 0) return null;

  // The shipped width is the one the inner selections agreed on most often —
  // averaging them would invent a width no fold ever chose.
  const modeD = [...new Set(chosen)].sort(
    (a, b) => chosen.filter((v) => v === b).length - chosen.filter((v) => v === a).length,
  )[0] ?? 0;
  const shape = shapeAt(rows, modeD);

  const round = (v: number): number => Math.round(v * 1e6) / 1e6;
  const model: AnchorModel = {
    ...spec,
    index,
    xbar: round(shape.xbar),
    ybar: round(shape.ybar),
    gain: round(shape.gain),
    ...(Math.abs(shape.gainBelow - shape.gain) > EPS ? { gainBelow: round(shape.gainBelow) } : {}),
    ...(modeD > EPS ? { deadband: round(modeD) } : {}),
    tailSkill: Math.round(meanOf(tail) * 1e4) / 1e4,
    skill: Math.round(meanOf(all) * 1e4) / 1e4,
  };
  // Two conditions, and both are needed.
  //
  // The tail has to be positive by more than its own spread across reshuffles —
  // the same discipline BASELINE.md applies everywhere else, since a single
  // per-parameter figure on a few hundred frames swings several points on its own.
  //
  // And the average may get worse, but never by more than the tail gains.
  //
  // An anchor buying reach always costs average MAE, which is why the tail is
  // what selects it — but the budget has to scale with what is being bought. A
  // flat allowance let `ToneCurvePoint224` through at +0.041 on the tail against
  // **−0.205** on the average: five points of everything spent for one point of
  // the extremes. Capping the loss at the tail's own gain makes the trade
  // self-scaling — a slider that rescues blown frames convincingly may spend
  // accordingly, one that barely helps may not spend at all — and the frame
  // head's own allowance stays the ceiling over the whole thing, so the two
  // mechanisms cannot disagree about the most error reach is ever worth.
  const tailOk = meanOf(tail) > sdOf(tail);
  const budget = Math.min(opts.maeAllowance, Math.max(0, meanOf(tail)));
  const averageOk = meanOf(all) > -budget;
  return { model, keep: tailOk && averageOk };
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
  return Math.min(param.absMax, Math.max(param.absMin, anchorApply(model, x)));
}
