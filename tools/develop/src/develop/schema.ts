/**
 * The develop target vector — the numeric contract this tool learns to predict.
 *
 * Each entry is one Adobe Camera Raw (process 2012) develop parameter, named by
 * its canonical XMP-crs tag (exactly what `shoots develop-export` emits after
 * reading the sidecar with exiftool). The tool owns the *order*, valid *ranges*,
 * the *delta reference* and the per-parameter *loss weight*; the CLI side stays
 * schema-agnostic and just forwards raw absolute crs values + as-shot metadata.
 *
 * Design decisions (locked by the plan):
 *  - We predict DELTAS, not absolutes. For sliders the neutral default is 0, so
 *    delta == value. White balance is the exception: Temp/Tint are camera-
 *    calibration-relative, so their delta is measured against the *as-shot* WB
 *    (Temp in log-Kelvin, a perceptual stop-like axis; Tint linearly).
 *  - Per-parameter standardization (z-score of the delta, fit on the training
 *    set) absorbs the wildly different ranges; ranges here are only used to clamp
 *    predictions back into valid ACR territory at inference.
 *  - Loss weighting emphasizes the *image-dependent* parameters (exposure, WB,
 *    contrast, highlights/shadows, dehaze/vibrance). Style-constant parameters
 *    (HSL, color grading) collapse to near-constant — correct, but they must not
 *    dominate an averaged loss, so they carry a small weight.
 *
 * Known v1 limitations: color-grade *hue* is circular (0..360) but modeled as a
 * plain linear output. In practice these are near-constant style params per
 * catalog, so wrap-around rarely bites; a sin/cos encoding is a v2 refinement.
 * Point curve (variable-length) is out of v1 (see plan Non-goals).
 */

/** How a parameter's absolute value maps to/from the learned delta space. */
export type Transform = 'linear' | 'logK';

/** What the delta is measured against. */
export type DeltaRef = 'zero' | 'asShotTemp' | 'asShotTint';

export interface DevelopParam {
  /** Canonical XMP-crs tag name (matches `shoots develop-export` output keys). */
  key: string;
  /** Coarse grouping, for per-group reporting in the evaluation. */
  group: 'tone' | 'presence' | 'wb' | 'hsl' | 'colorGrade' | 'paramCurve';
  /** Valid absolute range in ACR units — used to clamp predictions. */
  absMin: number;
  absMax: number;
  transform: Transform;
  ref: DeltaRef;
  /** Relative importance in the (weighted) training loss and the go/no-go metric. */
  weight: number;
}

const HSL_CHANNELS = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'] as const;

/** Build the 24 HSL params (Hue/Saturation/Luminance × 8 channels), weight 0.5. */
function hslParams(): DevelopParam[] {
  const out: DevelopParam[] = [];
  for (const aspect of ['HueAdjustment', 'SaturationAdjustment', 'LuminanceAdjustment'] as const) {
    for (const ch of HSL_CHANNELS) {
      out.push({ key: `${aspect}${ch}`, group: 'hsl', absMin: -100, absMax: 100, transform: 'linear', ref: 'zero', weight: 0.5 });
    }
  }
  return out;
}

const slider = (key: string, group: DevelopParam['group'], weight: number, min = -100, max = 100): DevelopParam => ({
  key,
  group,
  absMin: min,
  absMax: max,
  transform: 'linear',
  ref: 'zero',
  weight,
});

/**
 * The full ordered target list. The vector index of a param is its position
 * here; profiles pin this via {@link schemaVersion}.
 */
export const DEVELOP_PARAMS: DevelopParam[] = [
  // Tone — the most image-dependent block.
  slider('Exposure2012', 'tone', 3.0, -5, 5),
  slider('Contrast2012', 'tone', 2.0),
  slider('Highlights2012', 'tone', 2.0),
  slider('Shadows2012', 'tone', 2.0),
  slider('Whites2012', 'tone', 2.0),
  slider('Blacks2012', 'tone', 2.0),

  // Presence.
  slider('Texture', 'presence', 1.0),
  slider('Clarity2012', 'presence', 1.0),
  slider('Dehaze', 'presence', 1.5),
  slider('Vibrance', 'presence', 1.5),
  slider('Saturation', 'presence', 1.0),

  // White balance — delta measured against as-shot; Temp in log-Kelvin.
  { key: 'Temperature', group: 'wb', absMin: 2000, absMax: 50000, transform: 'logK', ref: 'asShotTemp', weight: 3.0 },
  { key: 'Tint', group: 'wb', absMin: -150, absMax: 150, transform: 'linear', ref: 'asShotTint', weight: 2.0 },

  // HSL (24).
  ...hslParams(),

  // Color grading (shadow/mid/highlight × H/S/L + blending + balance).
  slider('ColorGradeShadowHue', 'colorGrade', 0.5, 0, 360),
  slider('ColorGradeShadowSat', 'colorGrade', 0.5, 0, 100),
  slider('ColorGradeShadowLum', 'colorGrade', 0.5, -100, 100),
  slider('ColorGradeMidtoneHue', 'colorGrade', 0.5, 0, 360),
  slider('ColorGradeMidtoneSat', 'colorGrade', 0.5, 0, 100),
  slider('ColorGradeMidtoneLum', 'colorGrade', 0.5, -100, 100),
  slider('ColorGradeHighlightHue', 'colorGrade', 0.5, 0, 360),
  slider('ColorGradeHighlightSat', 'colorGrade', 0.5, 0, 100),
  slider('ColorGradeHighlightLum', 'colorGrade', 0.5, -100, 100),
  slider('ColorGradeBlending', 'colorGrade', 0.5, 0, 100),
  slider('SplitToningBalance', 'colorGrade', 0.5, -100, 100),

  // Parametric tone curve (4 regions).
  slider('ParametricHighlights', 'paramCurve', 1.0),
  slider('ParametricLights', 'paramCurve', 1.0),
  slider('ParametricDarks', 'paramCurve', 1.0),
  slider('ParametricShadows', 'paramCurve', 1.0),
];

/** Bump when the param list / order changes so old profiles are rejected. */
export const SCHEMA_VERSION = 1;

export const PARAM_COUNT = DEVELOP_PARAMS.length;

/** As-shot metadata that anchors the WB delta (and feeds the feature vector). */
export interface AsShotMeta {
  /** As-shot white-balance temperature (Kelvin). */
  tempAsShot: number | null;
  /** As-shot white-balance tint. */
  tintAsShot: number | null;
  iso: number | null;
  exposureComp: number | null;
  camera: string | null;
}

/** Resolve the reference value a param's delta is measured against. */
function refValue(param: DevelopParam, meta: AsShotMeta): number {
  switch (param.ref) {
    case 'asShotTemp':
      return meta.tempAsShot ?? 5500; // daylight fallback when as-shot WB is missing
    case 'asShotTint':
      return meta.tintAsShot ?? 0;
    case 'zero':
    default:
      return 0;
  }
}

/** Absolute crs value → learned delta space. */
export function encodeDelta(param: DevelopParam, absValue: number, meta: AsShotMeta): number {
  const ref = refValue(param, meta);
  if (param.transform === 'logK') {
    const safe = Math.max(absValue, 1);
    const safeRef = Math.max(ref, 1);
    return Math.log(safe) - Math.log(safeRef);
  }
  return absValue - ref;
}

/** Learned delta space → absolute crs value, clamped to the valid range. */
export function decodeDelta(param: DevelopParam, delta: number, meta: AsShotMeta): number {
  const ref = refValue(param, meta);
  let abs: number;
  if (param.transform === 'logK') {
    const safeRef = Math.max(ref, 1);
    abs = safeRef * Math.exp(delta);
  } else {
    abs = delta + ref;
  }
  return Math.min(param.absMax, Math.max(param.absMin, abs));
}
