/**
 * The canonical (ACR) develop vocabulary ↔ RapidRAW's `adjustments` object.
 *
 * Pure: no I/O, no filesystem, no exiftool. Everything that knows how the two
 * vocabularies line up lives here, so ingest and emit can never drift apart and
 * the whole mapping is testable against one real `.rrdata`.
 *
 * On provenance: RapidRAW ships its own ACR→RapidRAW preset importer
 * (`src-tauri/src/preset_converter.rs`), and the scale factors below agree with
 * it — 1.5 on Shadows, 1.5 on Tint, 0.75 on the HSL hues, 150 mired of white
 * balance travel. Those are measurable facts about their pipeline, not something
 * we get to choose: a different constant would simply render differently. The
 * code is ours; RapidRAW is AGPL-3.0 and none of it is copied or linked here.
 * Interoperating with a file format needs neither.
 */
import { HSL_CHANNELS } from '../../develop/schema.js';

/** RapidRAW's `adjustments` blob, kept loose — we own a slice of it, not all of it. */
export type RrAdjustments = Record<string, unknown>;

/** A point on a RapidRAW curve. */
interface RrPoint {
  x: number;
  y: number;
}

/**
 * One scalar parameter in both vocabularies.
 *
 * `rr` is a dot path because RapidRAW nests: `hsl.reds.saturation` rather than a
 * flat `SaturationAdjustmentRed`.
 */
interface ScalarMap {
  crs: string;
  rr: string;
  /** Canonical → RapidRAW. Identity when absent. */
  toRr?: (v: number) => number;
  /** RapidRAW → canonical. Identity when absent. */
  toCrs?: (v: number) => number;
}

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/** ACR's channel names → RapidRAW's plural ones. */
const HSL_KEY: Record<(typeof HSL_CHANNELS)[number], string> = {
  Red: 'reds',
  Orange: 'oranges',
  Yellow: 'yellows',
  Green: 'greens',
  Aqua: 'aquas',
  Blue: 'blues',
  Purple: 'purples',
  Magenta: 'magentas',
};

/** ACR's colour-grading regions → RapidRAW's. */
const GRADE_REGION: Record<string, string> = {
  Shadow: 'shadows',
  Midtone: 'midtones',
  Highlight: 'highlights',
  Global: 'global',
};

const GRADE_ASPECT: Record<string, string> = { Hue: 'hue', Sat: 'saturation', Lum: 'luminance' };

/**
 * Every scalar that survives the crossing, and what it costs to cross.
 *
 * White balance is absent on purpose: RapidRAW's Temperature is relative to the
 * as-shot value and cannot be converted without it (see {@link kelvinToRr}).
 */
export const SCALAR_MAP: ScalarMap[] = [
  // ── Tone and presence: the same slider under a different name ──────────────
  { crs: 'Exposure2012', rr: 'exposure' },
  { crs: 'Contrast2012', rr: 'contrast' },
  { crs: 'Highlights2012', rr: 'highlights' },
  { crs: 'Whites2012', rr: 'whites' },
  { crs: 'Blacks2012', rr: 'blacks' },
  { crs: 'Clarity2012', rr: 'clarity' },
  { crs: 'Dehaze', rr: 'dehaze' },
  { crs: 'Texture', rr: 'structure' },
  { crs: 'Vibrance', rr: 'vibrance' },
  { crs: 'Saturation', rr: 'saturation' },

  // RapidRAW's Shadows lifts less per unit than ACR's, so a faithful import
  // scales up — and saturates, which is why the inverse is lossy above ±67.
  {
    crs: 'Shadows2012',
    rr: 'shadows',
    toRr: (v) => clamp(v * 1.5, -100, 100),
    toCrs: (v) => v / 1.5,
  },

  // ── Effects ───────────────────────────────────────────────────────────────
  { crs: 'PostCropVignetteAmount', rr: 'vignetteAmount' },
  { crs: 'PostCropVignetteMidpoint', rr: 'vignetteMidpoint' },
  { crs: 'PostCropVignetteFeather', rr: 'vignetteFeather' },
  { crs: 'PostCropVignetteRoundness', rr: 'vignetteRoundness' },
  { crs: 'GrainAmount', rr: 'grainAmount' },
  { crs: 'GrainSize', rr: 'grainSize' },
  { crs: 'GrainFrequency', rr: 'grainRoughness' },

  // ── Camera calibration: 1:1, both −100..100 ───────────────────────────────
  { crs: 'ShadowTint', rr: 'colorCalibration.shadowsTint' },
  { crs: 'RedHue', rr: 'colorCalibration.redHue' },
  { crs: 'RedSaturation', rr: 'colorCalibration.redSaturation' },
  { crs: 'GreenHue', rr: 'colorCalibration.greenHue' },
  { crs: 'GreenSaturation', rr: 'colorCalibration.greenSaturation' },
  { crs: 'BlueHue', rr: 'colorCalibration.blueHue' },
  { crs: 'BlueSaturation', rr: 'colorCalibration.blueSaturation' },

  // ── Colour grading ────────────────────────────────────────────────────────
  { crs: 'ColorGradeBlending', rr: 'colorGrading.blending' },
  { crs: 'SplitToningBalance', rr: 'colorGrading.balance' },

  // ── Detail: captured by the exporter, never predicted ─────────────────────
  { crs: 'Sharpness', rr: 'sharpness', toRr: (v) => clamp(v / 1.5, 0, 100), toCrs: (v) => v * 1.5 },
  { crs: 'LuminanceSmoothing', rr: 'lumaNoiseReduction' },
  { crs: 'ColorNoiseReduction', rr: 'colorNoiseReduction' },

  // ── HSL: 8 channels × 3 aspects. The hue sliders are geared differently. ──
  ...HSL_CHANNELS.flatMap((ch): ScalarMap[] => [
    {
      crs: `HueAdjustment${ch}`,
      rr: `hsl.${HSL_KEY[ch]}.hue`,
      toRr: (v) => v * 0.75,
      toCrs: (v) => v / 0.75,
    },
    { crs: `SaturationAdjustment${ch}`, rr: `hsl.${HSL_KEY[ch]}.saturation` },
    { crs: `LuminanceAdjustment${ch}`, rr: `hsl.${HSL_KEY[ch]}.luminance` },
  ]),

  ...Object.entries(GRADE_REGION).flatMap(([crsRegion, rrRegion]): ScalarMap[] =>
    Object.entries(GRADE_ASPECT).map(([crsAspect, rrAspect]) => ({
      crs: `ColorGrade${crsRegion}${crsAspect}`,
      rr: `colorGrading.${rrRegion}.${rrAspect}`,
    })),
  ),
];

/**
 * Legacy split toning → the colour-grading fields it was folded into.
 *
 * ACR kept both mechanisms and writes both; RapidRAW has only the modern one, so
 * emitting from both would have the second silently overwrite the first. These
 * are therefore a *fallback*, consulted only where the modern key is absent —
 * and never produced on the way in, since one representation cannot honestly
 * become two.
 */
export const SPLIT_TONING_FALLBACK: { crs: string; rr: string }[] = [
  { crs: 'SplitToningShadowHue', rr: 'colorGrading.shadows.hue' },
  { crs: 'SplitToningShadowSaturation', rr: 'colorGrading.shadows.saturation' },
  { crs: 'SplitToningHighlightHue', rr: 'colorGrading.highlights.hue' },
  { crs: 'SplitToningHighlightSaturation', rr: 'colorGrading.highlights.saturation' },
];

// ── White balance ────────────────────────────────────────────────────────────

/**
 * How far RapidRAW's Temperature slider travels, end to end, in mired.
 *
 * Mired rather than Kelvin because that is what the slider is linear in — and
 * what perceived warmth is roughly linear in, which is why every editor's WB
 * control works this way. 150 mired against a 5500 K capture reaches from about
 * 3000 K to about 31000 K.
 */
const MIRED_SPAN = 150;
const DEFAULT_AS_SHOT_K = 5500;

/** Guard the reciprocal: a warm slider on an already-cold capture can cross zero. */
const MIN_MIRED = 20; // 50000 K, the schema's own ceiling
const MAX_MIRED = 500; // 2000 K, its floor

/** Absolute Kelvin → RapidRAW's as-shot-relative Temperature slider (−100..100). */
export function kelvinToRr(kelvin: number, asShotKelvin: number | null | undefined): number {
  const asShot = asShotKelvin && asShotKelvin > 0 ? asShotKelvin : DEFAULT_AS_SHOT_K;
  const delta = 1e6 / Math.max(kelvin, 1) - 1e6 / asShot;
  return clamp((-delta / MIRED_SPAN) * 100, -100, 100);
}

/** RapidRAW's Temperature slider → absolute Kelvin, the canonical unit. */
export function rrToKelvin(temperature: number, asShotKelvin: number | null | undefined): number {
  const asShot = asShotKelvin && asShotKelvin > 0 ? asShotKelvin : DEFAULT_AS_SHOT_K;
  const mired = clamp(1e6 / asShot - (temperature / 100) * MIRED_SPAN, MIN_MIRED, MAX_MIRED);
  return 1e6 / mired;
}

/** ACR Tint (−150..150) → RapidRAW's (−100..100). */
export const tintToRr = (v: number): number => clamp(v / 1.5, -100, 100);
/** The inverse. Lossy past ±100 in RapidRAW units, which is the whole range. */
export const tintToCrs = (v: number): number => v * 1.5;

// ── Tone curve ───────────────────────────────────────────────────────────────

/** A flattened canonical curve `[x0,y0,x1,y1,…]` → RapidRAW's point list. */
export function curveToRr(flat: number[]): RrPoint[] {
  const points: RrPoint[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) points.push({ x: flat[i]!, y: flat[i + 1]! });
  return points;
}

/** RapidRAW's point list → a flattened canonical curve, or undefined when unusable. */
export function curveToCrs(points: unknown): number[] | undefined {
  if (!Array.isArray(points) || points.length < 2) return undefined;
  const flat: number[] = [];
  for (const point of points) {
    if (!point || typeof point !== 'object') return undefined;
    const { x, y } = point as Partial<RrPoint>;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      return undefined;
    }
    flat.push(x, y);
  }
  return flat.length >= 4 ? flat : undefined;
}

/** True when a RapidRAW curve is the identity line (y = x at every point). */
export function isIdentityCurve(points: unknown): boolean {
  const flat = curveToCrs(points);
  if (!flat) return true; // absent or degenerate — nothing was drawn
  for (let i = 0; i + 1 < flat.length; i += 2) {
    if (Math.abs(flat[i]! - flat[i + 1]!) > 0.5) return false;
  }
  return true;
}

// ── Nested access ────────────────────────────────────────────────────────────

/** Read a dot path out of a RapidRAW adjustments blob, as a finite number or null. */
export function readPath(adjustments: RrAdjustments, dotPath: string): number | null {
  let node: unknown = adjustments;
  for (const key of dotPath.split('.')) {
    if (!node || typeof node !== 'object') return null;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === 'number' && Number.isFinite(node) ? node : null;
}

/** Write a dot path into a patch object, creating the intermediate objects. */
export function writePath(patch: RrAdjustments, dotPath: string, value: unknown): void {
  const keys = dotPath.split('.');
  let node = patch;
  for (const key of keys.slice(0, -1)) {
    if (!node[key] || typeof node[key] !== 'object') node[key] = {};
    node = node[key] as RrAdjustments;
  }
  node[keys[keys.length - 1]!] = value;
}

/**
 * Deep-merge a patch over an existing adjustments blob, in place on a copy.
 *
 * Plain objects merge key by key so a patch touching `hsl.reds.saturation` does
 * not wipe the other seven channels; everything else — arrays especially, which
 * is what masks and curves are — replaces wholesale.
 */
export function mergeAdjustments(base: RrAdjustments, patch: RrAdjustments): RrAdjustments {
  const out: RrAdjustments = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    const bothPlain =
      value !== null && typeof value === 'object' && !Array.isArray(value) &&
      existing !== null && typeof existing === 'object' && !Array.isArray(existing);
    out[key] = bothPlain
      ? mergeAdjustments(existing as RrAdjustments, value as RrAdjustments)
      : value;
  }
  return out;
}

// ── Neutral state ────────────────────────────────────────────────────────────

/**
 * The RapidRAW keys that constitute a *look*, with the value each holds when
 * untouched (from the app's own `INITIAL_ADJUSTMENTS`).
 *
 * Not every non-zero default is a decision: RapidRAW writes a whole adjustments
 * object the moment a file is saved, with `grainSize: 25`, `vignetteMidpoint: 50`
 * and `blending: 50` already in it. Reading those as an edit would mark an
 * entire untouched catalog as training data — the same trap the ACR adapter
 * documents at `isEdited`.
 *
 * Geometry, lens correction, masks and AI patches are deliberately absent: lens
 * corrections default to *enabled* at full strength, so including them would
 * make every file look edited, and none of the four is part of the look this
 * tool predicts.
 */
export const RR_NEUTRAL: Record<string, number> = {
  exposure: 0,
  brightness: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  temperature: 0,
  tint: 0,
  hue: 0,
  saturation: 0,
  vibrance: 0,
  clarity: 0,
  dehaze: 0,
  structure: 0,
  vignetteAmount: 0,
  vignetteMidpoint: 50,
  vignetteFeather: 50,
  vignetteRoundness: 0,
  grainAmount: 0,
  grainSize: 25,
  grainRoughness: 50,
  glowAmount: 0,
  halationAmount: 0,
  flareAmount: 0,
  'colorGrading.blending': 50,
  'colorGrading.balance': 0,
  ...Object.fromEntries(
    Object.values(GRADE_REGION).flatMap((region) =>
      Object.values(GRADE_ASPECT).map((aspect) => [`colorGrading.${region}.${aspect}`, 0]),
    ),
  ),
  ...Object.fromEntries(
    Object.values(HSL_KEY).flatMap((channel) =>
      ['hue', 'saturation', 'luminance'].map((aspect) => [`hsl.${channel}.${aspect}`, 0]),
    ),
  ),
  ...Object.fromEntries(
    ['shadowsTint', 'redHue', 'redSaturation', 'greenHue', 'greenSaturation', 'blueHue', 'blueSaturation'].map(
      (key) => [`colorCalibration.${key}`, 0],
    ),
  ),
};

/** The four channels RapidRAW keeps a curve for. */
export const CURVE_CHANNELS = ['luma', 'red', 'green', 'blue'] as const;

/**
 * A deliberate edit, as opposed to the defaults RapidRAW writes on save.
 *
 * Tested against the RapidRAW values rather than the converted canonical ones:
 * the conversion is lossy in places (Shadows saturates, hues are geared), and a
 * round trip through it would make "untouched" a question of floating-point
 * luck. Here it is exact.
 */
export function isEdited(adjustments: RrAdjustments | null | undefined): boolean {
  if (!adjustments) return false;
  for (const [dotPath, neutral] of Object.entries(RR_NEUTRAL)) {
    const value = readPath(adjustments, dotPath);
    if (value !== null && Math.abs(value - neutral) > 1e-6) return true;
  }
  const curves = adjustments['curves'];
  if (curves && typeof curves === 'object') {
    for (const channel of CURVE_CHANNELS) {
      if (!isIdentityCurve((curves as Record<string, unknown>)[channel])) return true;
    }
  }
  // A LUT is the whole look in one file, and none of the sliders above move for it.
  if (typeof adjustments['lutPath'] === 'string' && adjustments['lutPath']) return true;
  return false;
}

// ── The two crossings ────────────────────────────────────────────────────────

/**
 * RapidRAW → the canonical develop map (crs property names).
 *
 * White balance is *not* in the result: RapidRAW states it as a shift relative
 * to the capture, the canonical vocabulary as an absolute temperature, and only
 * the camera knows what the shift is relative to. Omitted rather than defaulted,
 * because a plausible 5500 K standing in for an unknown anchor is a wrong target
 * that nothing downstream can distinguish from a real one — see
 * {@link canonicalTemperature}, which the capture pass completes it with.
 */
export function toCanonical(adjustments: RrAdjustments): Record<string, number> {
  const develop: Record<string, number> = {};
  for (const entry of SCALAR_MAP) {
    const value = readPath(adjustments, entry.rr);
    if (value === null) continue;
    develop[entry.crs] = entry.toCrs ? entry.toCrs(value) : value;
  }
  const tint = readPath(adjustments, 'tint');
  if (tint !== null) develop['Tint'] = tintToCrs(tint);
  return develop;
}

/**
 * The absolute Kelvin an edit amounts to, once the capture is known. Null when
 * the edit says nothing about white balance at all.
 *
 * `asShotKelvin` falls back to 5500 K, matching what the schema's own delta
 * reference does for a capture with no recorded temperature — so the *delta* the
 * trainer sees comes out right either way, which is the number that matters.
 */
export function canonicalTemperature(
  adjustments: RrAdjustments,
  asShotKelvin: number | null | undefined,
): number | null {
  const temperature = readPath(adjustments, 'temperature');
  return temperature === null ? null : rrToKelvin(temperature, asShotKelvin);
}

/** The luma point curve of a RapidRAW edit, flattened, or undefined when linear. */
export function canonicalCurve(adjustments: RrAdjustments): number[] | undefined {
  const curves = adjustments['curves'];
  if (!curves || typeof curves !== 'object') return undefined;
  const luma = (curves as Record<string, unknown>)['luma'];
  return isIdentityCurve(luma) ? undefined : curveToCrs(luma);
}

/** The sections {@link toRapidRaw} writes into, which must be visible to apply. */
const WRITTEN_SECTIONS = ['basic', 'color', 'curves', 'details', 'effects'] as const;

/**
 * The canonical develop map → a RapidRAW adjustments *patch*, to be merged over
 * whatever the file already holds.
 *
 * A patch rather than a whole object because a `.rrdata` is the photographer's:
 * it carries their masks, their crop, their lens corrections and their LUT, none
 * of which this tool predicts and all of which a wholesale template would erase.
 */
export function toRapidRaw(
  develop: Record<string, number>,
  curve: number[] | undefined,
  asShotKelvin: number | null | undefined,
): RrAdjustments {
  const patch: RrAdjustments = {};

  for (const entry of SCALAR_MAP) {
    const value = develop[entry.crs];
    if (value === undefined || !Number.isFinite(value)) continue;
    writePath(patch, entry.rr, round(entry.toRr ? entry.toRr(value) : value));
  }

  // Legacy split toning only where the modern key said nothing — see the note on
  // SPLIT_TONING_FALLBACK.
  for (const entry of SPLIT_TONING_FALLBACK) {
    if (readPath(patch, entry.rr) !== null) continue;
    const value = develop[entry.crs];
    if (value === undefined || !Number.isFinite(value)) continue;
    writePath(patch, entry.rr, round(value));
  }

  const kelvin = develop['Temperature'];
  if (kelvin !== undefined && Number.isFinite(kelvin)) {
    writePath(patch, 'temperature', round(kelvinToRr(kelvin, asShotKelvin)));
  }
  const tint = develop['Tint'];
  if (tint !== undefined && Number.isFinite(tint)) writePath(patch, 'tint', round(tintToRr(tint)));

  if (curve && curve.length >= 4) {
    const points = curveToRr(curve);
    // `curves` is the curve RapidRAW actually renders; `pointCurves` is where it
    // stashes the point-mode state while the parametric editor has the floor.
    // Writing both, and pinning the mode, is what makes the prediction visible in
    // the UI *and* survive a trip through the parametric tab.
    writePath(patch, 'curves.luma', points);
    writePath(patch, 'pointCurves.luma', points);
    patch['curveMode'] = 'point';
  }

  // A hidden section is not a collapsed panel: the renderer substitutes zero for
  // every value in it (`is_visible` in image_processing.rs). Left alone, a
  // prediction would land in the file, read correctly, and change nothing.
  const visibility: Record<string, boolean> = {};
  for (const section of WRITTEN_SECTIONS) visibility[section] = true;
  patch['sectionVisibility'] = visibility;

  return patch;
}

/** RapidRAW's sliders are integers apart from exposure; keep the JSON readable. */
function round(v: number): number {
  return Math.round(v * 100) / 100;
}
