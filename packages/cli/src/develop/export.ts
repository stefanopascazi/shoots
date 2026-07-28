/**
 * shoots develop export <path>
 *
 * Fase 0/1 of the local "Lightroom AI" plan: build the training dataset the
 * `develop` tool consumes. For each image it emits, per file:
 *   - the CLIP embedding (semantic / genre context) — reuses the same model as
 *     `shoots embeddings`;
 *   - explicit color/exposure features from the BASELINE render (our own code);
 *   - the develop settings the photographer actually applied, read from the
 *     XMP-crs tags via exiftool (the supervised target);
 *   - as-shot metadata (WB temperature, ISO, exposure comp, camera) that anchors
 *     the white-balance delta and enters the feature vector.
 *
 * This command is deliberately schema-agnostic about the target: it forwards
 * every crs value it finds as a name→number map. The `develop` tool owns the
 * ordered param schema and the delta encoding.
 *
 * Output is JSONL, streamed to disk as each file completes: one record per line
 * plus a trailing `_type: "develop-meta"` line (model, dims, baseline, summary).
 * This keeps memory flat for very large catalogs (20k+ RAW) instead of buffering
 * every embedding in RAM and serializing one giant JSON at the end.
 *
 * BASELINE render: `embedded-preview` (default) uses the RAW's embedded JPEG (an
 * approximation — bakes in the camera picture style); `external` renders a
 * neutral, camera-independent baseline via a stand-alone RAW developer (see
 * rawDeveloper.ts). The chosen strategy is recorded in the meta line.
 */
import path from 'node:path';
import { existsSync, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { JobQueue, scanFiles } from '@shoots/core';
import { extractColorFeatures, COLOR_FEATURE_NAMES, readMetadata, isRawFile, type ExifRecord } from '@shoots/imaging';
import { resolveRawDeveloper, withNeutralRender, type RawDeveloper } from '../rawDeveloper.js';
import {
  createQualityModel,
  getProfile,
  DEFAULT_PROFILE_NAME,
  type ModelKind,
} from '@shoots/inference';
import {
  logError,
  logVerbose,
  makeIo,
  markFailure,
  parsePositiveInt,
  printHuman,
  printJson,
} from '../io.js';
import { startPhase, startProgress } from '../progress.js';
import { ensureClipModelReady, ensureExiftoolReady, ensureLibrawReady } from '../tools.js';

/**
 * The develop-setting crs tags we pull from each sidecar, requested with the
 * `XMP-crs:` group prefix so they never collide with the identically named EXIF
 * tags (Saturation, Contrast, Sharpness…). Kept in sync with the `develop`
 * tool's schema; extra/missing tags are harmless (the tool ignores unknowns and
 * treats absent params as neutral).
 */
const CHANNELS = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'] as const;
const CRS_TARGET_TAGS: string[] = [
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

/** As-shot / capture metadata tags (EXIF), read edit-independently from the RAW. */
const META_TAGS = ['ColorTemperature', 'ISO', 'ExposureCompensation', 'Model'] as const;

/**
 * Where a file's develop settings live. For proprietary RAW (CR3, NEF, ARW…)
 * Lightroom writes a `<basename>.xmp` sidecar; exiftool does NOT merge it when
 * reading the RAW, so we must point it at the sidecar. DNG/JPEG embed the crs
 * settings, so those fall back to the file itself.
 */
function developSource(file: string): string {
  const parsed = path.parse(file);
  const sidecar = path.join(parsed.dir, `${parsed.name}.xmp`);
  return existsSync(sidecar) ? sidecar : file;
}

export const BASELINES = ['embedded-preview', 'external'] as const;
type Baseline = (typeof BASELINES)[number];

export interface DevelopExportOptions {
  model: string;
  concurrency: string;
  out: string;
  baseline: string;
  editedOnly?: boolean;
  json?: boolean;
  verbose?: boolean;
}

interface AsShot {
  tempAsShot: number | null;
  tintAsShot: number | null;
  iso: number | null;
  exposureComp: number | null;
  camera: string | null;
}

/** One record line in the JSONL dataset (baseline lives in the trailing meta line). */
interface DatasetRecord {
  file: string;
  embedding: number[];
  features: number[];
  develop: Record<string, number>;
  asShot: AsShot;
  /** Black-and-white vs colour, read deterministically off the edit (HSL ↔ GrayMixer). */
  treatment: 'color' | 'bw';
  /** Base rendering profile (crs CameraProfile), e.g. "Camera Faithful v2". */
  baseProfile?: string;
  /** Flattened point tone-curve [x0,y0,x1,y1,…] (ToneCurvePV2012) — the contrast
   *  / black-clipping vehicle, absent when the curve is linear/default. */
  curve?: number[];
}

/** Deterministic B&W vs colour from the edit structure. */
function deriveTreatment(develop: Record<string, number>): 'color' | 'bw' {
  if (develop['ConvertToGrayscale'] === 1) return 'bw';
  if (Object.keys(develop).some((k) => k.startsWith('GrayMixer'))) return 'bw';
  return 'color';
}

/** Coerce an exiftool value to a finite number, or null. */
function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const n = parseFloat(value.replace(/[^0-9eE.+-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Pull the crs develop settings actually present on a record (absent = neutral). */
function readDevelop(record: ExifRecord | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!record) return out;
  for (const tag of CRS_TARGET_TAGS) {
    const raw = record[tag];
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
function readCurve(record: ExifRecord | undefined): number[] | undefined {
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

function readAsShot(crs: ExifRecord | undefined, exif: ExifRecord | undefined): AsShot {
  const wb = typeof crs?.['WhiteBalance'] === 'string' ? (crs['WhiteBalance'] as string) : null;
  const chosenTemp = num(crs?.['Temperature']);
  const exifTemp = num(exif?.['ColorTemperature']);
  // As-shot Kelvin reference for the WB delta. If the photographer left WB
  // "As Shot", the chosen temp IS the as-shot temp (delta 0). If they changed it,
  // anchor on the RAW's EXIF color temperature; fall back to the chosen value
  // (delta 0) when no edit-independent anchor exists.
  const tempAsShot = !wb || wb === 'As Shot' ? (chosenTemp ?? exifTemp) : (exifTemp ?? chosenTemp);
  return {
    tempAsShot,
    tintAsShot: null, // no clean edit-independent Kelvin tint source; delta falls back to 0
    iso: num(exif?.['ISO']),
    exposureComp: num(exif?.['ExposureCompensation']),
    camera: typeof exif?.['Model'] === 'string' ? (exif['Model'] as string) : null,
  };
}

export async function runDevelopExport(targetPath: string, options: DevelopExportOptions): Promise<void> {
  const io = makeIo(options);

  const AVAILABLE_MODELS: ModelKind[] = ['onnx'];
  if (!AVAILABLE_MODELS.includes(options.model as ModelKind)) {
    logError(`unknown inference model '${options.model}' (available: ${AVAILABLE_MODELS.join(', ')})`);
    process.exitCode = 2;
    return;
  }
  if (!BASELINES.includes(options.baseline as Baseline)) {
    logError(`unknown --baseline '${options.baseline}' (available: ${BASELINES.join(', ')})`);
    process.exitCode = 2;
    return;
  }
  const baseline = options.baseline as Baseline;

  // The external neutral baseline needs a RAW developer (see rawDeveloper.ts).
  // Unless the user pointed us at their own via SHOOTS_RAW_DEVELOPER, provision
  // the bundled LibRaw dcraw_emu on first use. Resolve up front so we fail fast,
  // not 700 files in.
  let developer: RawDeveloper | null = null;
  if (baseline === 'external') {
    if (!process.env.SHOOTS_RAW_DEVELOPER?.trim()) {
      if (!(await ensureLibrawReady(io))) return;
    }
    developer = resolveRawDeveloper();
    if (!developer) {
      logError(
        'baseline "external" needs a RAW developer: run `shoots setup`, or set SHOOTS_RAW_DEVELOPER ' +
          'to a binary (e.g. dcraw_emu / rawtherapee-cli), optionally SHOOTS_RAW_DEVELOPER_ARGS to override the neutral args.',
      );
      process.exitCode = 2;
      return;
    }
  }

  const profile = getProfile(DEFAULT_PROFILE_NAME)!;
  const model = createQualityModel(options.model as ModelKind, { profile });

  // Everything from here to the per-file progress bar is bulk I/O with nothing to
  // count yet. On a network catalog that is minutes of apparent silence, so each
  // step announces itself.
  const scanPhase = startPhase(io, 'Scanning');
  const files = await scanFiles(targetPath, {
    onProgress: (found) => scanPhase.update(`${found} files`),
  });
  scanPhase.done(`${files.length} files`);
  if (files.length === 0) {
    printHuman(io, 'No image files found.');
    if (io.json) printJson({ command: 'develop-export', model: model.name, dim: 0, results: [], summary: { total: 0, exported: 0, failed: 0, withDevelop: 0 } });
    return;
  }
  logVerbose(io, `Exporting develop dataset for ${files.length} files (baseline: ${baseline})`);

  if (!(await ensureExiftoolReady(io))) return;
  if (!(await ensureClipModelReady(io))) return;

  // crs develop targets first, from the sidecars (cheap): needed for ALL files to
  // decide which are edited. crs comes from the sidecar (or embedded, for DNG/JPEG).
  const developSrcByFile = new Map(files.map((f) => [f.path, developSource(f.path)] as const));
  const crsPaths = [...new Set(developSrcByFile.values())];
  const crsTagArgs = [...CRS_TARGET_TAGS.map((t) => `XMP-crs:${t}`), 'XMP-crs:WhiteBalance', 'XMP-crs:ToneCurvePV2012', 'XMP-crs:CameraProfile'];
  const crsPhase = startPhase(io, 'Reading develop settings');
  const crsRecords = await readMetadata(crsPaths, {
    tags: crsTagArgs,
    onProgress: (done, total) => crsPhase.update(`${done}/${total}`),
  });
  crsPhase.done(`${crsPaths.length} files`);
  const crsByPath = new Map<string, ExifRecord>();
  for (const rec of crsRecords) crsByPath.set(path.resolve(rec.SourceFile), rec);
  const crsFor = (file: string): ExifRecord | undefined => crsByPath.get(path.resolve(developSrcByFile.get(file)!));

  // --edited-only: skip the expensive per-file work (embedding / neutral render /
  // color features) AND the as-shot EXIF read for files with no develop settings.
  // This is the right default for training-set builds (we train on edited photos
  // only) and avoids opening thousands of large unedited RAWs.
  const workFiles = options.editedOnly
    ? files.filter((f) => Object.keys(readDevelop(crsFor(f.path))).length > 0)
    : files;
  if (options.editedOnly) {
    // Worth surfacing outside --verbose: this is the number that decides how long
    // the expensive pass will take, and a surprising 0 is the usual mistake.
    printHuman(io, `edited-only: ${workFiles.length}/${files.length} files carry develop settings`);
  }
  if (workFiles.length === 0) {
    printHuman(io, options.editedOnly ? 'No edited files found (nothing carries develop settings).' : 'No files to process.');
    return;
  }

  // As-shot EXIF, read from the image files themselves — only for the files we
  // will actually process (opening RAWs is comparatively expensive).
  const exifPhase = startPhase(io, 'Reading capture metadata');
  const exifRecords = await readMetadata(workFiles.map((f) => f.path), {
    tags: [...META_TAGS],
    onProgress: (done, total) => exifPhase.update(`${done}/${total}`),
  });
  exifPhase.done(`${workFiles.length} files`);
  const exifByPath = new Map<string, ExifRecord>();
  for (const rec of exifRecords) exifByPath.set(path.resolve(rec.SourceFile), rec);

  await mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
  const stream = createWriteStream(options.out, { encoding: 'utf8' });
  let writeFailed = false;
  stream.on('error', (err: Error) => {
    logError(`failed writing dataset: ${err.message}`);
    writeFailed = true;
  });
  // One atomic write per line (no interleaving across concurrent workers); await
  // drain on backpressure so memory stays bounded even for huge catalogs.
  const writeLine = async (obj: unknown): Promise<void> => {
    if (!stream.write(JSON.stringify(obj) + '\n')) await once(stream, 'drain');
  };
  const round5 = (v: number): number => Math.round(v * 1e5) / 1e5;

  const modelPhase = startPhase(io, 'Loading inference model');
  await model.init();
  modelPhase.done(model.name);

  const queue = new JobQueue({ concurrency: parsePositiveInt(options.concurrency, 4) });
  const progress = await startProgress(io, workFiles.length, 'Develop-export');

  // Stream each record to disk as it completes (JSONL); return only lightweight
  // counters so nothing is accumulated in memory.
  const outcomes = await queue.run(
    workFiles,
    async (file): Promise<{ hasDevelop: boolean; dim: number }> => {
      // CLIP stays on the embedded preview (semantic, colour-invariant); only the
      // photometric color features move to the neutral render when requested.
      const colorTask =
        developer && isRawFile(file.path)
          ? withNeutralRender(developer, file.path, (rendered) => extractColorFeatures(rendered))
          : extractColorFeatures(file.path);
      const [assessment, color] = await Promise.all([model.assess({ path: file.path }), colorTask]);
      if (!assessment.embedding) throw new Error('backend produced no embedding (unsupported model?)');

      const crsRec = crsFor(file.path);
      const exifRec = exifByPath.get(path.resolve(file.path));
      const develop = readDevelop(crsRec);
      const curve = readCurve(crsRec);
      const baseProfile = typeof crsRec?.['CameraProfile'] === 'string' ? (crsRec['CameraProfile'] as string) : undefined;
      const record: DatasetRecord = {
        file: file.path,
        embedding: assessment.embedding.map(round5),
        features: color.vector,
        develop,
        asShot: readAsShot(crsRec, exifRec),
        treatment: deriveTreatment(develop),
        ...(baseProfile ? { baseProfile } : {}),
        ...(curve ? { curve } : {}),
      };
      await writeLine(record);
      return { hasDevelop: Object.keys(develop).length > 0, dim: assessment.embedding.length };
    },
    progress.onProgress,
    (file) => file.name,
  );

  progress.stop();
  await model.dispose();

  const ok = outcomes.filter((o) => o.ok);
  const errors = outcomes
    .filter((o) => !o.ok)
    .map((o) => ({ file: o.item.path, error: o.error?.message ?? 'unknown error' }));
  const withDevelop = ok.filter((o) => o.value!.hasDevelop).length;
  const dim = ok.find((o) => o.value)?.value!.dim ?? 0;
  const summary = { total: files.length, processed: workFiles.length, exported: ok.length, failed: errors.length, withDevelop };

  // Trailing meta line: dataset-level fields (dim is known only now) + summary.
  await writeLine({
    _type: 'develop-meta',
    command: 'develop-export',
    model: model.name,
    dim,
    colorFeatureNames: COLOR_FEATURE_NAMES,
    colorDim: COLOR_FEATURE_NAMES.length,
    baseline,
    summary,
  });
  await new Promise<void>((resolve) => stream.end(resolve));
  if (writeFailed) {
    markFailure();
    return;
  }

  printHuman(io, `Wrote develop dataset to ${options.out}: ${ok.length} images, ${withDevelop} with develop settings (baseline: ${baseline}).`);
  if (io.json) printJson({ command: 'develop-export', model: model.name, dim, colorDim: COLOR_FEATURE_NAMES.length, baseline, out: options.out, summary });

  if (withDevelop === 0 && ok.length > 0) {
    logError('No develop settings found on any file — check that XMP sidecars / crs metadata are present.');
    markFailure();
  }
  for (const e of errors) logError(`${e.file}: ${e.error}`);
  if (errors.length > 0) markFailure();
}
