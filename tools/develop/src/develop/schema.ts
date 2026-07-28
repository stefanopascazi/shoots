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
export type DeltaRef = 'zero' | 'asShotTemp' | 'asShotTint';
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
  weight: number;
}

const HSL_CHANNELS = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'] as const;

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

/** Bump when the param list / order / branches / feature layout change. */
export const SCHEMA_VERSION = 3;

/** Parameters predicted for a given treatment: shared + that treatment's branch. */
export function paramsForTreatment(treatment: Treatment): DevelopParam[] {
  return DEVELOP_PARAMS.filter((p) => p.branch === 'shared' || p.branch === treatment);
}

/** As-shot metadata that anchors the WB delta (and feeds the feature vector). */
export interface AsShotMeta {
  tempAsShot: number | null;
  tintAsShot: number | null;
  iso: number | null;
  exposureComp: number | null;
  camera: string | null;
}

function refValue(param: DevelopParam, meta: AsShotMeta): number {
  switch (param.ref) {
    case 'asShotTemp':
      return meta.tempAsShot ?? 5500;
    case 'asShotTint':
      return meta.tintAsShot ?? 0;
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
