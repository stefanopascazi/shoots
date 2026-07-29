/**
 * Adobe Camera Raw / Lightroom → canonical develop edit.
 *
 * Everything that knows how ACR stores an edit lives here: which crs tags carry
 * the look, how exiftool names them, where the sidecar sits, and how to tell a
 * real edit from the neutral defaults Lightroom sprays into every file it
 * touches. `develop export` and `develop refresh-targets` both read through
 * this module, so the two can never drift.
 *
 * The canonical vocabulary IS the ACR one (see `develop/schema.ts`): keys are
 * XMP crs property names. A future non-Adobe adapter translates into these
 * names rather than the other way round.
 */
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { ExifRecord } from '@shoots/imaging';
import { logWarn, printHuman, type CliIo } from '../../../io.js';
import { DEVELOP_PARAMS, treatmentFromDevelop, type AsShotMeta } from '../../develop/schema.js';

/**
 * The develop-setting crs tags we pull from each sidecar, requested with the
 * `XMP-crs:` group prefix so they never collide with the identically named EXIF
 * tags (Saturation, Contrast, Sharpness…). Kept in sync with the `develop`
 * tool's schema; extra/missing tags are harmless (the tool ignores unknowns and
 * treats absent params as neutral).
 */
const CHANNELS = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'] as const;
export const CRS_TARGET_TAGS: string[] = [
  // Tone / presence / WB.
  'Exposure2012', 'Contrast2012', 'Highlights2012', 'Shadows2012', 'Whites2012', 'Blacks2012',
  'Texture', 'Clarity2012', 'Dehaze', 'Vibrance', 'Saturation',
  'Temperature', 'Tint',
  // Parametric tone curve (+ its split points).
  'ParametricHighlights', 'ParametricLights', 'ParametricDarks', 'ParametricShadows',
  'ParametricShadowSplit', 'ParametricMidtoneSplit', 'ParametricHighlightSplit',
  // Colour HSL (8×3) and the B&W mixer (8) — mutually exclusive by treatment.
  ...(['HueAdjustment', 'SaturationAdjustment', 'LuminanceAdjustment'] as const).flatMap((a) => CHANNELS.map((c) => `${a}${c}`)),
  ...CHANNELS.map((c) => `GrayMixer${c}`),
  // Colour grading (shadow/mid/highlight/global × H/S/L) + blending + balance.
  ...(['Shadow', 'Midtone', 'Highlight', 'Global'] as const).flatMap((r) => [`ColorGrade${r}Hue`, `ColorGrade${r}Sat`, `ColorGrade${r}Lum`]),
  'ColorGradeBlending', 'SplitToningBalance',
  // Legacy split toning.
  'SplitToningShadowHue', 'SplitToningShadowSaturation', 'SplitToningHighlightHue', 'SplitToningHighlightSaturation',
  // Camera calibration.
  'ShadowTint', 'RedHue', 'RedSaturation', 'GreenHue', 'GreenSaturation', 'BlueHue', 'BlueSaturation',
  // Effects (vignette + grain).
  'PostCropVignetteAmount', 'PostCropVignetteMidpoint', 'PostCropVignetteFeather', 'PostCropVignetteRoundness',
  'GrainAmount', 'GrainSize', 'GrainFrequency', 'VignetteAmount',
  // Detail — captured for completeness but NOT prediction targets (finishing, not
  // the starting point): sharpening + noise reduction.
  'Sharpness', 'SharpenRadius', 'SharpenDetail', 'SharpenEdgeMasking',
  'LuminanceSmoothing', 'LuminanceNoiseReductionDetail', 'LuminanceNoiseReductionContrast',
  'ColorNoiseReduction', 'ColorNoiseReductionDetail', 'ColorNoiseReductionSmoothness',
  // Treatment flag (B&W vs colour) — routing, captured as 1/0.
  'ConvertToGrayscale',
];

/** crs boolean tags exiftool returns as "True"/"False" — captured as 1/0. */
const CRS_BOOL_TAGS = new Set(['ConvertToGrayscale']);

/**
 * XMP property name → the tag name exiftool exposes it under.
 *
 * exiftool does not always name a tag after its XMP property. `crs:Temperature`
 * is published as `ColorTemperature`, so asking for `XMP-crs:Temperature`
 * returns *nothing at all* — silently, with no warning. That cost us the single
 * most image-dependent target in the schema: white balance was absent from every
 * record of a 1045-image catalog while the trainer happily reported 100% skill on
 * it (a constant target is trivially "predicted").
 *
 * Keep this map as the one place where the two vocabularies differ. As of
 * exiftool 13.59, `Temperature` is the only renamed tag among CRS_TARGET_TAGS
 * (verified with `exiftool -listx -XMP-crs:all`).
 */
export const CRS_TAG_ALIASES: Record<string, string> = {
  Temperature: 'ColorTemperature',
};

/** The exiftool tag name to request/read for a canonical crs property. */
export const exifToolTag = (crsProperty: string): string => CRS_TAG_ALIASES[crsProperty] ?? crsProperty;

/** exiftool `-tags` for the crs read: the targets plus the routing/context tags. */
export const CRS_TAG_ARGS: string[] = [
  ...CRS_TARGET_TAGS.map((t) => `XMP-crs:${exifToolTag(t)}`),
  'XMP-crs:WhiteBalance', 'XMP-crs:ToneCurvePV2012', 'XMP-crs:CameraProfile',
  // The creative profiles (Adobe Color, Adobe Monochrome, …) are NOT a
  // CameraProfile value: they are a base profile plus a *Look* layered on top,
  // and `crs:CameraProfile` reports only the base. Reading it alone collapses
  // "Adobe Standard v2" and "Adobe Standard v2 + Adobe Color" — two very
  // different renderings — into one label. On a real catalog that was 206 of 428
  // colour edits mislabelled, and the single largest style split in it.
  'XMP-crs:LookName', 'XMP-crs:LookUUID',
];

/**
 * As-shot / capture metadata tags, read edit-independently from the RAW.
 *
 * WB anchors, in order of what they mean (Canon names; other makers expose
 * equivalents that exiftool normalizes to the same tags):
 *  - `ColorTempAsShot`   the WB the camera actually recorded — the delta anchor.
 *  - `ColorTempMeasured` the camera's own *measured* scene temperature. Unlike
 *    the as-shot value it moves with the light, not with the WB dial, so it is
 *    an edit-independent estimate of the answer the photographer is about to
 *    pick. Captured for the feature vector.
 *  - `ColorTemperature`  fallback for bodies exposing neither of the above.
 */
export const META_TAGS = [
  'ColorTempAsShot', 'ColorTempMeasured', 'ColorTemperature',
  'ISO', 'ExposureCompensation', 'Model',
] as const;

/**
 * Where a file's develop settings live. For proprietary RAW (CR3, NEF, ARW…)
 * Lightroom writes a `<basename>.xmp` sidecar; exiftool does NOT merge it when
 * reading the RAW, so we must point it at the sidecar. DNG/JPEG embed the crs
 * settings, so those fall back to the file itself.
 */
export function developSource(file: string): string {
  const parsed = path.parse(file);
  const sidecar = path.join(parsed.dir, `${parsed.name}.xmp`);
  return existsSync(sidecar) ? sidecar : file;
}

/** Coerce an exiftool value to a finite number, or null. */
export function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  // exiftool renders EXIF rationals as fractions: ExposureCompensation comes
  // back as "-1/3". Stripping the slash the way the generic path below does
  // would read that as -13 — a third of a stop becoming thirteen stops, in a
  // feature the model consumes directly.
  const ratio = /^([+-]?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(text);
  if (ratio) {
    const denominator = parseFloat(ratio[2]!);
    if (denominator === 0) return null;
    const v = parseFloat(ratio[1]!) / denominator;
    return Number.isFinite(v) ? v : null;
  }
  const n = parseFloat(text.replace(/[^0-9eE.+-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Pull the crs develop settings actually present on a record (absent = neutral).
 * Keys are the canonical XMP property names, so the schema never has to know
 * about exiftool's renames (see {@link CRS_TAG_ALIASES}).
 */
export function readDevelop(record: ExifRecord | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!record) return out;
  for (const tag of CRS_TARGET_TAGS) {
    const raw = record[exifToolTag(tag)];
    if (CRS_BOOL_TAGS.has(tag)) {
      if (raw === true || raw === 'True') out[tag] = 1;
      else if (raw === false || raw === 'False') out[tag] = 0;
      continue;
    }
    const n = num(raw);
    if (n !== null) out[tag] = n;
  }
  return out;
}

/** Parse the point tone curve (ToneCurvePV2012) into flat [x0,y0,x1,y1,…]. */
export function readCurve(record: ExifRecord | undefined): number[] | undefined {
  const raw = record?.['ToneCurvePV2012'];
  if (raw == null) return undefined;
  // exiftool returns the Seq as an array of "x, y" strings or one joined string;
  // String() + split on comma handles both.
  const nums = String(raw)
    .split(',')
    .map((s) => parseFloat(s.trim()))
    .filter((n) => Number.isFinite(n));
  return nums.length >= 4 ? nums : undefined;
}

/** Base rendering profile (crs CameraProfile), e.g. "Camera Faithful v2". */
export function readBaseProfile(record: ExifRecord | undefined): string | undefined {
  const raw = record?.['CameraProfile'];
  return typeof raw === 'string' ? raw : undefined;
}

/** The creative profile layered over the base one (crs Look), e.g. "Adobe Color". */
export function readLookName(record: ExifRecord | undefined): string | undefined {
  const raw = record?.['LookName'];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * The verbatim `<crs:Look>…</crs:Look>` element of a sidecar.
 *
 * Kept as raw XML rather than rebuilt from the flattened exiftool fields on
 * purpose. A Look carries a UUID, a look-table digest and a tone curve, and
 * which of those Lightroom needs in order to resolve and apply it is Adobe's
 * business, not ours. Replaying the element exactly as Lightroom wrote it is the
 * only version we can be sure is right; reconstructing a "probably sufficient"
 * subset would be a guess that fails silently inside someone else's catalog.
 *
 * Only sidecars can be read this way — for embedded crs (DNG/JPEG) there is no
 * element to lift, and the caller emits the base profile alone.
 */
export function readLookXml(source: string): string | undefined {
  if (!source.toLowerCase().endsWith('.xmp')) return undefined;
  let text: string;
  try {
    text = readFileSync(source, 'utf8');
  } catch {
    return undefined;
  }
  return /<crs:Look>[\s\S]*?<\/crs:Look>/.exec(text)?.[0];
}

export function readAsShot(crs: ExifRecord | undefined, exif: ExifRecord | undefined): AsShotMeta {
  const wb = typeof crs?.['WhiteBalance'] === 'string' ? (crs['WhiteBalance'] as string) : null;
  // The photographer's chosen Kelvin, from the sidecar. Note this reads the crs
  // record under exiftool's name for crs:Temperature — same spelling as the EXIF
  // tag below, but a different record and a different meaning.
  const chosenTemp = num(crs?.[exifToolTag('Temperature')]);
  // The camera's own as-shot Kelvin, edit-independent by construction.
  const captureTemp = num(exif?.['ColorTempAsShot']) ?? num(exif?.['ColorTemperature']);
  // As-shot Kelvin reference for the WB delta. If the photographer left WB
  // "As Shot", the chosen temp IS the as-shot temp (delta 0). If they changed it,
  // anchor on the camera's as-shot temperature; fall back to the chosen value
  // (delta 0) when no edit-independent anchor exists.
  const tempAsShot = !wb || wb === 'As Shot' ? (chosenTemp ?? captureTemp) : (captureTemp ?? chosenTemp);
  return {
    tempAsShot,
    // The camera's measured scene temperature — tracks the light rather than the
    // WB dial, so it is a genuine edit-independent hint at the Kelvin the
    // photographer is about to dial in.
    tempMeasured: num(exif?.['ColorTempMeasured']),
    tintAsShot: null, // no clean edit-independent Kelvin tint source; delta falls back to 0
    iso: num(exif?.['ISO']),
    exposureComp: num(exif?.['ExposureCompensation']),
    camera: typeof exif?.['Model'] === 'string' ? (exif['Model'] as string) : null,
  };
}

/** Deterministic B&W vs colour — canonical logic, shared with training. */
export const deriveTreatment = treatmentFromDevelop;

/**
 * Predicted targets whose neutral value is not zero. Lightroom writes these into
 * every file it touches, so they must not be read as evidence of an edit.
 *
 * (The schema encodes deltas from zero for these, which is harmless: a constant
 * offset vanishes under the per-parameter standardization applied at train time.)
 */
const NEUTRAL_DEFAULTS: Record<string, number> = {
  ColorGradeBlending: 50,
};

/**
 * True when a file carries an actual edit, not merely crs tags.
 *
 * Lightroom writes neutral crs defaults into any file it has touched — every
 * DNG it creates gets Sharpness 40, ColorNoiseReduction 25, the parametric curve
 * split points, and a full set of zeroed sliders. "Has develop settings" is
 * therefore not "was edited": on a real catalog that let ~12% of files through
 * as identity examples, teaching the model to predict "change nothing".
 *
 * Test the *predicted targets* against their neutral reference instead.
 * {@link DEVELOP_PARAMS} is exactly that set, so the defaults Lightroom writes
 * for non-target settings (sharpening, noise reduction, curve split points,
 * vignette geometry) are excluded for free.
 */
export function isEdited(
  develop: Record<string, number>,
  curve: number[] | undefined,
  crs: ExifRecord | undefined,
): boolean {
  // Sliders: neutral is 0, so any non-zero target is a deliberate move — except
  // where Lightroom's own neutral is not zero. ColorGradeBlending defaults to 50
  // and is written into every file, so treating 0 as its neutral would mark the
  // entire catalog as edited and defeat the whole check.
  for (const param of DEVELOP_PARAMS) {
    if (param.ref !== 'zero') continue; // WB is relative to as-shot; handled below
    const value = develop[param.key];
    if (value !== undefined && value !== (NEUTRAL_DEFAULTS[param.key] ?? 0)) return true;
  }
  // A black-and-white conversion is unambiguously an edit.
  if (develop['ConvertToGrayscale'] === 1) return true;
  // WB: neutral means the edit still says "As Shot".
  const wb = crs?.['WhiteBalance'];
  if (typeof wb === 'string' && wb !== 'As Shot') return true;
  // Point curve: neutral is the identity line, which Lightroom still writes out.
  if (curve && curve.length >= 4) {
    for (let i = 0; i < curve.length; i += 2) {
      if (curve[i] !== curve[i + 1]) return true;
    }
  }
  return false;
}

/**
 * Warn about target tags that never appeared on a single file.
 *
 * A crs tag we ask for under the wrong name comes back as silence, not an error,
 * and silence reads downstream as "the photographer never touched this" — a
 * constant target that the trainer then scores as perfectly predicted. That is
 * how white balance stayed missing from an entire catalog while the GATE
 * reported 100% skill on it. One tag absent everywhere is a spelling bug far
 * more often than it is a real habit, so say so out loud.
 */
export function warnNeverSeenTargets(io: CliIo, records: ExifRecord[]): void {
  if (records.length === 0) return;
  const seen = new Set<string>();
  for (const rec of records) {
    for (const tag of CRS_TARGET_TAGS) {
      if (rec[exifToolTag(tag)] !== undefined) seen.add(tag);
    }
  }
  // Not one target on any file: these images were simply never edited, which is
  // the normal shape of a set you are exporting in order to *predict* on it.
  // Listing all ninety-odd tags there would be pure noise, and would train the
  // reader to ignore the one warning that matters.
  if (seen.size === 0) return;
  const missing = CRS_TARGET_TAGS.filter((t) => !seen.has(t));
  if (missing.length === 0) return;
  logWarn(
    `${missing.length} develop tag(s) absent from all ${records.length} files — ` +
      `they will train as constants: ${missing.join(', ')}`,
  );
  printHuman(io, '  (if one you actively use is listed, suspect the exiftool tag name, not the catalog)');
}
