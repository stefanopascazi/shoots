/**
 * The develop target vector — the numeric contract this tool learns to predict.
 *
 * Each entry is one Adobe Camera Raw (process 2012) develop parameter, named by
 * its canonical XMP-crs tag (exactly what `shoots develop-export` emits). The tool
 * owns the *order*, valid *ranges*, delta *reference*, per-parameter *loss weight*
 * and the **branch** the parameter belongs to.
 *
 * Branches (the black-and-white vs colour split is deterministic from the edit —
 * B&W uses the GrayMixer, colour uses HSL; they are mutually exclusive):
 *   - `shared` : predicted for every photo (tone, WB, presence, curve, calibration,
 *     effects) — the global-look foundation.
 *   - `color`  : predicted only for colour photos (HSL, colour grading, split tone).
 *   - `bw`     : predicted only for B&W photos (the 8-channel grayscale mixer).
 * A model is trained per treatment over `shared + <its branch>`; routing is
 * deterministic at train time (the treatment is read off the edit) and a
 * human/content choice at inference.
 *
 * We deliberately predict the *starting point*, not the finished edit: sharpening,
 * noise reduction, lens/geometry corrections are captured in the dataset but are
 * NOT targets here (see the develop-export capture list).
 *
 * Design decisions (locked by the plan):
 *  - Predict DELTAS. For sliders the neutral default is 0 (delta == value). White
 *    balance is the exception: Temp/Tint are camera-calibration-relative, so their
 *    delta is against the *as-shot* WB (Temp in log-Kelvin).
 *  - Per-parameter z-score standardization of the delta absorbs the disparate
 *    ranges; ranges here only clamp predictions back into valid ACR territory.
 *  - Loss weighting emphasizes image-dependent params; style-constants carry a
 *    small weight so they cannot dominate an averaged loss.
 *
 * Known v1 limitation: hue params (colour grade / calibration / split tone) are
 * circular (0..360) but modeled linearly — fine while they are near-constant per
 * catalog. Point curve is captured separately (dataset `curve`), not a target here.
 */

export type Transform = 'linear' | 'logK';
export type DeltaRef = 'zero' | 'asShotTemp' | 'asShotTint' | 'const';
export type Branch = 'shared' | 'color' | 'bw';
export type Treatment = 'color' | 'bw';

export interface DevelopParam {
  /** Canonical XMP-crs tag name (matches `shoots develop-export` output keys). */
  key: string;
  group: string;
  branch: Branch;
  absMin: number;
  absMax: number;
  transform: Transform;
  ref: DeltaRef;
  /** The neutral value, for `ref: 'const'` — a tone-curve knot's own input. */
  refConst?: number;
  weight: number;
}

const HSL_CHANNELS = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'] as const;

/**
 * Inputs at which the point tone curve is sampled, and therefore predicted.
 *
 * The *point* curve, not the parametric one. Which of the two a photographer
 * uses is a habit, not a preference the tool gets to have: on the catalog this
 * was built against, all four `Parametric*` sliders are zero on all 553 edits
 * while a third of them carry a non-identity `ToneCurvePV2012` — so the schema
 * was predicting the mechanism its photographer never touches and ignoring the
 * one carrying the look. On black-and-white it is not a garnish but the
 * conversion itself (mean |error| against the identity curve: 9.6 for B&W
 * against 1.5 for colour).
 *
 * Nine knots is a compromise measured on that catalog: the curve's deviation
 * from linear peaks around x≈48 and x≈176, which five knots blur and fourteen
 * would only fit more noise with.
 */
export const CURVE_KNOTS = [0, 32, 64, 96, 128, 160, 192, 224, 255] as const;

/**
 * The synthetic param key for one knot.
 *
 * Synthetic because a curve is not a crs *attribute*: ACR stores it as an
 * rdf:Seq of "x, y" points, and no per-knot tag exists to name. Sampling it onto
 * a fixed grid is what turns it into something a fixed-width regressor can
 * predict at all, and the keys never collide with real crs tags because no crs
 * tag is spelled this way. The emitter turns them back into the Seq.
 */
export const curveParamKey = (knot: number): string => `ToneCurvePoint${knot}`;

/** One knot as a develop parameter: neutral is the identity curve, y = x. */
const curveParam = (knot: number): DevelopParam => ({
  key: curveParamKey(knot),
  group: 'toneCurve',
  branch: 'shared',
  absMin: 0,
  absMax: 255,
  transform: 'linear',
  ref: 'const',
  refConst: knot,
  weight: 1.0,
});

/** Shorthand for a plain −100..100 linear slider. */
const slider = (key: string, group: string, branch: Branch, weight: number, min = -100, max = 100): DevelopParam => ({
  key,
  group,
  branch,
  absMin: min,
  absMax: max,
  transform: 'linear',
  ref: 'zero',
  weight,
});

// ── Shared: predicted for every photo (the global-look foundation) ────────────
const SHARED: DevelopParam[] = [
  slider('Exposure2012', 'tone', 'shared', 3.0, -5, 5),
  slider('Contrast2012', 'tone', 'shared', 2.0),
  slider('Highlights2012', 'tone', 'shared', 2.0),
  slider('Shadows2012', 'tone', 'shared', 2.0),
  slider('Whites2012', 'tone', 'shared', 2.0),
  slider('Blacks2012', 'tone', 'shared', 2.0),

  slider('Texture', 'presence', 'shared', 1.0),
  slider('Clarity2012', 'presence', 'shared', 1.0),
  slider('Dehaze', 'presence', 'shared', 1.5),

  { key: 'Temperature', group: 'wb', branch: 'shared', absMin: 2000, absMax: 50000, transform: 'logK', ref: 'asShotTemp', weight: 3.0 },
  { key: 'Tint', group: 'wb', branch: 'shared', absMin: -150, absMax: 150, transform: 'linear', ref: 'asShotTint', weight: 2.0 },

  slider('ParametricHighlights', 'paramCurve', 'shared', 1.0),
  slider('ParametricLights', 'paramCurve', 'shared', 1.0),
  slider('ParametricDarks', 'paramCurve', 'shared', 1.0),
  slider('ParametricShadows', 'paramCurve', 'shared', 1.0),

  // Camera calibration — affects the underlying colour (and the B&W conversion).
  slider('ShadowTint', 'calibration', 'shared', 0.5),
  slider('RedHue', 'calibration', 'shared', 0.5),
  slider('RedSaturation', 'calibration', 'shared', 0.5),
  slider('GreenHue', 'calibration', 'shared', 0.5),
  slider('GreenSaturation', 'calibration', 'shared', 0.5),
  slider('BlueHue', 'calibration', 'shared', 0.5),
  slider('BlueSaturation', 'calibration', 'shared', 0.5),

  // Effects — part of the look, apply in colour and B&W.
  slider('PostCropVignetteAmount', 'effects', 'shared', 0.5),
  slider('GrainAmount', 'effects', 'shared', 0.5, 0, 100),

  ...CURVE_KNOTS.map(curveParam),
];

// ── Colour branch: predicted only for colour photos ──────────────────────────
const COLOR: DevelopParam[] = [
  slider('Vibrance', 'presence', 'color', 1.5),
  slider('Saturation', 'presence', 'color', 1.0),

  ...(['HueAdjustment', 'SaturationAdjustment', 'LuminanceAdjustment'] as const).flatMap((aspect) =>
    HSL_CHANNELS.map((ch) => slider(`${aspect}${ch}`, 'hsl', 'color', 0.5)),
  ),

  ...(['Shadow', 'Midtone', 'Highlight', 'Global'] as const).flatMap((region) => [
    slider(`ColorGrade${region}Hue`, 'colorGrade', 'color', 0.5, 0, 360),
    slider(`ColorGrade${region}Sat`, 'colorGrade', 'color', 0.5, 0, 100),
    slider(`ColorGrade${region}Lum`, 'colorGrade', 'color', 0.5),
  ]),
  slider('ColorGradeBlending', 'colorGrade', 'color', 0.5, 0, 100),
  slider('SplitToningBalance', 'colorGrade', 'color', 0.5),

  slider('SplitToningShadowHue', 'splitTone', 'color', 0.3, 0, 360),
  slider('SplitToningShadowSaturation', 'splitTone', 'color', 0.3, 0, 100),
  slider('SplitToningHighlightHue', 'splitTone', 'color', 0.3, 0, 360),
  slider('SplitToningHighlightSaturation', 'splitTone', 'color', 0.3, 0, 100),
];

// ── B&W branch: predicted only for black-and-white photos ────────────────────
// NOTE: empirically the B&W tonal look is much harder to predict than colour
// (skill ~4% vs ~16% on real data). High-contrast B&W is a per-image *artistic*
// decision (curve peaks, deliberate black clipping) more than a reproducible
// recipe — the tool offers a weak starting point here by design, not a bug.
const BW: DevelopParam[] = HSL_CHANNELS.map((ch) => slider(`GrayMixer${ch}`, 'grayMixer', 'bw', 1.0));

/** The full ordered list (shared + colour + B&W). A param's index is its position. */
export const DEVELOP_PARAMS: DevelopParam[] = [...SHARED, ...COLOR, ...BW];

/**
 * Bump when the param list / order / branches / feature layout change, or when
 * the profile gains a field inference depends on.
 *
 * v4: per-parameter gating. A profile carries `gatedParams`, and prediction
 * falls back to the photographer's constant for those — a v3 profile has no
 * such list, so it would silently emit model output the evidence rejected.
 *
 * v5: per-parameter ridge strength. `ridgeLambda` (one λ for the whole vector)
 * became `paramLambda` (one per parameter), and the weights of a v4 profile were
 * all fitted at the single λ that the unpredictable majority of parameters
 * chose. Inference reads no λ, so the numbers would still decode — which is the
 * problem: a v4 profile would keep serving its collapsed predictions in silence.
 *
 * v6: the base rendering became profile + Look rather than profile alone, so
 * `profileVocab` gave way to `renderVocab` over a different vocabulary, and
 * `defaultRender` is what inference now substitutes for an unedited file (and
 * writes into the sidecar). A v5 profile's vocabulary merges every Adobe Color
 * photograph with the plain-profile ones it was rendered nothing like.
 *
 * v7: the point tone curve joined the target vector as nine per-knot parameters,
 * so the param list and its order changed — and a v6 profile's weights are
 * indexed by the old list.
 *
 * v8: the feature vector gained the session mean and the embedding block became
 * variable-width (dropped, projected, or raw). Both change the layout the
 * weights are indexed by, and a v7 profile has no projection to reproduce.
 *
 * v9: one model per branch became two — a *level* head over the shoot and a
 * *frame* head over how far this photograph departs from it, added together, each
 * with its own λ, its own gate and its own de-shrinking slope. A v8 profile has a
 * single weight matrix over a layout that no longer exists, and more to the point
 * it was a per-shoot constant generator: on the reference catalog it moved
 * Highlights by a standard deviation of 2.3 points inside a shoot where the
 * photographer moved it by 15.3. λ also changed units — it is now shrinkage per
 * sample, so a stored v8 λ read as a v9 one would be off by the catalog size.
 */
export const SCHEMA_VERSION = 9;

/** Parameters predicted for a given treatment: shared + that treatment's branch. */
export function paramsForTreatment(treatment: Treatment): DevelopParam[] {
  return DEVELOP_PARAMS.filter((p) => p.branch === 'shared' || p.branch === treatment);
}

/**
 * B&W vs colour, read off a canonical develop map.
 *
 * The explicit grayscale flag wins whenever present, in *both* directions.
 * Falling through to "a GrayMixer exists, therefore B&W" would misread a colour
 * photo that merely carries mixer values — the shape of a file where a B&W look
 * was tried and then switched back off.
 *
 * Lives here rather than in an adapter: the treatment is a property of the
 * canonical vocabulary, and both ingest and training must agree on it.
 */
export function treatmentFromDevelop(develop: Record<string, number>): Treatment {
  const flag = develop['ConvertToGrayscale'];
  if (flag !== undefined) return flag === 1 ? 'bw' : 'color';
  if (Object.keys(develop).some((k) => k.startsWith('GrayMixer'))) return 'bw';
  return 'color';
}

/**
 * The base rendering an edit sits on: camera profile plus any creative Look.
 *
 * Two fields rather than one because that is how the editor stores it — "Adobe
 * Color" is not a CameraProfile value, it is "Adobe Standard v2" with a Look
 * layered over it. Reading only the profile merges renderings that look nothing
 * alike, and every predicted slider is relative to whichever one was active.
 */
export interface RenderProfile {
  profile?: string;
  look?: string;
}

/**
 * A render as a single vocabulary token — the conditioning key, and the label a
 * report shows. Undefined when there is nothing to condition on at all.
 */
export function renderKey(render: RenderProfile | undefined): string | undefined {
  if (!render?.profile && !render?.look) return undefined;
  const base = render.profile ?? '(default)';
  return render.look ? `${base}${RENDER_SEP}${render.look}` : base;
}

const RENDER_SEP = ' + ';

/** {@link renderKey} in reverse — a bare profile name is a valid key. */
export function parseRenderKey(key: string): RenderProfile {
  const at = key.indexOf(RENDER_SEP);
  return at < 0
    ? { profile: key }
    : { profile: key.slice(0, at), look: key.slice(at + RENDER_SEP.length) };
}

/** As-shot metadata that anchors the WB delta (and feeds the feature vector). */
export interface AsShotMeta {
  tempAsShot: number | null;
  /**
   * The camera's *measured* scene temperature, where the body reports one.
   * Distinct from {@link tempAsShot}: it follows the light rather than the WB
   * dial, so it is an edit-independent estimate of the Kelvin the photographer
   * will choose. Captured by the exporter; absent on older datasets.
   */
  tempMeasured?: number | null;
  tintAsShot: number | null;
  iso: number | null;
  exposureComp: number | null;
  camera: string | null;
  /**
   * Hour of capture, 0..23 local, from EXIF. Absent on older datasets.
   *
   * A frame shot at sunset and one shot at noon ask different questions of the
   * white balance: warming the first is honouring the light, warming the second
   * is inventing it. Nothing in the pixels separates the two reliably — a warm
   * scene at noon looks like a neutral scene at golden hour — but the clock does.
   */
  hour?: number | null;
}

function refValue(param: DevelopParam, meta: AsShotMeta): number {
  switch (param.ref) {
    case 'asShotTemp':
      return meta.tempAsShot ?? 5500;
    case 'asShotTint':
      return meta.tintAsShot ?? 0;
    case 'const':
      return param.refConst ?? 0;
    default:
      return 0;
  }
}

/** Absolute crs value → learned delta space. */
export function encodeDelta(param: DevelopParam, absValue: number, meta: AsShotMeta): number {
  const ref = refValue(param, meta);
  if (param.transform === 'logK') {
    return Math.log(Math.max(absValue, 1)) - Math.log(Math.max(ref, 1));
  }
  return absValue - ref;
}

/** Learned delta space → absolute crs value, clamped to the valid range. */
export function decodeDelta(param: DevelopParam, delta: number, meta: AsShotMeta): number {
  const ref = refValue(param, meta);
  const abs = param.transform === 'logK' ? Math.max(ref, 1) * Math.exp(delta) : delta + ref;
  return Math.min(param.absMax, Math.max(param.absMin, abs));
}

/**
 * Sample a flattened point curve `[x0,y0,x1,y1,…]` at {@link CURVE_KNOTS}.
 *
 * Absent or degenerate curve ⇒ the identity, which is exactly what "the
 * photographer left the curve alone" means.
 */
export function sampleCurve(curve: number[] | undefined): number[] {
  if (!curve || curve.length < 4) return CURVE_KNOTS.map((x) => x);
  const points: [number, number][] = [];
  for (let i = 0; i + 1 < curve.length; i += 2) points.push([curve[i]!, curve[i + 1]!]);
  points.sort((a, b) => a[0] - b[0]);
  return CURVE_KNOTS.map((x) => {
    if (x <= points[0]![0]) return points[0]![1];
    const last = points[points.length - 1]!;
    if (x >= last[0]) return last[1];
    for (let i = 0; i + 1 < points.length; i++) {
      const [x0, y0] = points[i]!;
      const [x1, y1] = points[i + 1]!;
      if (x >= x0 && x <= x1) return y0 + ((x - x0) / (x1 - x0 || 1)) * (y1 - y0);
    }
    return x;
  });
}

/**
 * A develop map with the tone curve materialized as per-knot targets.
 *
 * Done here rather than in the exporter so the dataset format stays put: the
 * full curve is already in every record, and turning it into knots is a pure
 * function of it. Everything downstream — delta encoding, the never-moves test,
 * evaluation, gating — then treats the curve like any other parameter.
 */
export function withCurveTargets(
  develop: Record<string, number>,
  curve: number[] | undefined,
): Record<string, number> {
  const out = { ...develop };
  const sampled = sampleCurve(curve);
  CURVE_KNOTS.forEach((knot, i) => { out[curveParamKey(knot)] = sampled[i]!; });
  return out;
}

/** How far a knot may sit from identity and still count as "curve untouched". */
const CURVE_IDENTITY_TOLERANCE = 0.5;

/**
 * Rebuild a flattened point curve from predicted knots, or undefined when the
 * prediction is the identity (writing out a pointless straight line would tell
 * the editor a decision was made where none was).
 *
 * Outputs are forced non-decreasing. A regressor fits each knot independently
 * and nothing stops it returning a curve that dips backwards; ACR would accept
 * that and render a solarized frame, which is never what a starting point means.
 */
export function curveFromDevelop(develop: Record<string, number>): number[] | undefined {
  const ys: number[] = [];
  let previous = 0;
  let moved = false;
  for (const knot of CURVE_KNOTS) {
    const raw = develop[curveParamKey(knot)];
    if (raw === undefined || !Number.isFinite(raw)) return undefined;
    const y = Math.max(previous, Math.min(255, Math.round(raw)));
    if (Math.abs(y - knot) > CURVE_IDENTITY_TOLERANCE) moved = true;
    ys.push(y);
    previous = y;
  }
  if (!moved) return undefined;
  return CURVE_KNOTS.flatMap((x, i) => [x, ys[i]!]);
}
