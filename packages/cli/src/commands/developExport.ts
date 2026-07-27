/**
 * shoots develop-export <path>
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
 * BASELINE render (the plan's "vero rischio"): a colorimetrically correct
 * neutral render needs Lightroom (virtual-copy reset) or an external RAW
 * developer. Neither is wired yet, so v1 defaults to `--baseline embedded-preview`
 * — the RAW's embedded JPEG (or the file itself for rendered formats). This is an
 * APPROXIMATION, recorded in the dataset so the evaluation is read with the right
 * caveat; `virtual-copy` / `external-developer` are future strategies.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import type { Command } from 'commander';
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
import { startProgress } from '../progress.js';
import { ensureClipModelReady, ensureExiftoolReady } from '../tools.js';

/**
 * The develop-setting crs tags we pull from each sidecar, requested with the
 * `XMP-crs:` group prefix so they never collide with the identically named EXIF
 * tags (Saturation, Contrast, Sharpness…). Kept in sync with the `develop`
 * tool's schema; extra/missing tags are harmless (the tool ignores unknowns and
 * treats absent params as neutral).
 */
const CRS_TARGET_TAGS: string[] = [
  'Exposure2012', 'Contrast2012', 'Highlights2012', 'Shadows2012', 'Whites2012', 'Blacks2012',
  'Texture', 'Clarity2012', 'Dehaze', 'Vibrance', 'Saturation',
  'Temperature', 'Tint',
  ...(['HueAdjustment', 'SaturationAdjustment', 'LuminanceAdjustment'] as const).flatMap((a) =>
    ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'].map((c) => `${a}${c}`),
  ),
  'ColorGradeShadowHue', 'ColorGradeShadowSat', 'ColorGradeShadowLum',
  'ColorGradeMidtoneHue', 'ColorGradeMidtoneSat', 'ColorGradeMidtoneLum',
  'ColorGradeHighlightHue', 'ColorGradeHighlightSat', 'ColorGradeHighlightLum',
  'ColorGradeBlending', 'SplitToningBalance',
  'ParametricHighlights', 'ParametricLights', 'ParametricDarks', 'ParametricShadows',
];

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

const BASELINES = ['embedded-preview', 'external'] as const;
type Baseline = (typeof BASELINES)[number];

interface DevelopExportOptions {
  model: string;
  concurrency: string;
  out?: string;
  baseline: string;
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

interface DevelopExportResult {
  file: string;
  embedding: number[];
  features: number[];
  develop: Record<string, number>;
  asShot: AsShot;
  baseline: Baseline;
}

export function registerDevelopExportCommand(program: Command): void {
  program
    .command('develop-export')
    .description('Export a develop-prediction training dataset (CLIP + color features + crs targets) for the `develop` tool')
    .argument('<path>', 'folder (or single file) of RAW/edited images carrying develop settings')
    .option('--model <kind>', 'inference backend (default: onnx)', 'onnx')
    .option('--concurrency <n>', 'max parallel jobs', '4')
    .option('--out <file>', 'write the dataset JSON to this path (default: stdout with --json)')
    .option('--baseline <mode>', `baseline render strategy: ${BASELINES.join(' | ')}`, 'embedded-preview')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runDevelopExport);
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
    const n = num(record[tag]);
    if (n !== null) out[tag] = n;
  }
  return out;
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

async function runDevelopExport(targetPath: string, options: DevelopExportOptions): Promise<void> {
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

  // The external neutral baseline needs a configured RAW developer (see
  // rawDeveloper.ts). Resolve it up front so we fail fast, not 700 files in.
  let developer: RawDeveloper | null = null;
  if (baseline === 'external') {
    developer = resolveRawDeveloper();
    if (!developer) {
      logError(
        'baseline "external" needs a RAW developer: set SHOOTS_RAW_DEVELOPER to the binary ' +
          '(e.g. dcraw_emu / rawtherapee-cli), optionally SHOOTS_RAW_DEVELOPER_ARGS to override the neutral args.',
      );
      process.exitCode = 2;
      return;
    }
  }

  const profile = getProfile(DEFAULT_PROFILE_NAME)!;
  const model = createQualityModel(options.model as ModelKind, { profile });

  const files = await scanFiles(targetPath);
  if (files.length === 0) {
    printHuman(io, 'No image files found.');
    if (io.json) printJson({ command: 'develop-export', model: model.name, dim: 0, results: [], summary: { total: 0, exported: 0, failed: 0, withDevelop: 0 } });
    return;
  }
  logVerbose(io, `Exporting develop dataset for ${files.length} files (baseline: ${baseline})`);

  if (!(await ensureExiftoolReady(io))) return;
  if (!(await ensureClipModelReady(io))) return;

  // Two batched metadata reads, keyed by resolved path so per-file jobs are pure
  // map lookups. crs develop targets come from the sidecar (or embedded, for
  // DNG/JPEG); as-shot EXIF always from the image file itself.
  const developSrcByFile = new Map(files.map((f) => [f.path, developSource(f.path)] as const));
  const crsPaths = [...new Set(developSrcByFile.values())];
  const crsTagArgs = [...CRS_TARGET_TAGS.map((t) => `XMP-crs:${t}`), 'XMP-crs:WhiteBalance'];
  const [crsRecords, exifRecords] = await Promise.all([
    readMetadata(crsPaths, { tags: crsTagArgs }),
    readMetadata(files.map((f) => f.path), { tags: [...META_TAGS] }),
  ]);
  const crsByPath = new Map<string, ExifRecord>();
  for (const rec of crsRecords) crsByPath.set(path.resolve(rec.SourceFile), rec);
  const exifByPath = new Map<string, ExifRecord>();
  for (const rec of exifRecords) exifByPath.set(path.resolve(rec.SourceFile), rec);

  await model.init();
  const queue = new JobQueue({ concurrency: parsePositiveInt(options.concurrency, 4) });
  const progress = await startProgress(io, files.length, 'Develop-export');

  const outcomes = await queue.run(
    files,
    async (file): Promise<DevelopExportResult> => {
      // CLIP stays on the embedded preview (semantic, colour-invariant); only the
      // photometric color features move to the neutral render when requested.
      const colorTask =
        developer && isRawFile(file.path)
          ? withNeutralRender(developer, file.path, (rendered) => extractColorFeatures(rendered))
          : extractColorFeatures(file.path);
      const [assessment, color] = await Promise.all([model.assess({ path: file.path }), colorTask]);
      if (!assessment.embedding) throw new Error('backend produced no embedding (unsupported model?)');

      const crsRec = crsByPath.get(path.resolve(developSrcByFile.get(file.path)!));
      const exifRec = exifByPath.get(path.resolve(file.path));
      return {
        file: file.path,
        embedding: assessment.embedding,
        features: color.vector,
        develop: readDevelop(crsRec),
        asShot: readAsShot(crsRec, exifRec),
        baseline,
      };
    },
    progress.onProgress,
    (file) => file.name,
  );

  progress.stop();
  await model.dispose();

  const exported = outcomes.filter((o) => o.ok).map((o) => o.value!);
  const errors = outcomes
    .filter((o) => !o.ok)
    .map((o) => ({ file: o.item.path, error: o.error?.message ?? 'unknown error' }));

  const withDevelop = exported.filter((r) => Object.keys(r.develop).length > 0).length;
  const dataset = {
    command: 'develop-export' as const,
    model: model.name,
    dim: exported[0]?.embedding.length ?? 0,
    colorFeatureNames: COLOR_FEATURE_NAMES,
    colorDim: COLOR_FEATURE_NAMES.length,
    baseline,
    results: exported,
    errors,
    summary: { total: files.length, exported: exported.length, failed: errors.length, withDevelop },
  };

  if (options.out) {
    await mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
    await writeFile(options.out, JSON.stringify(dataset, null, 2) + '\n', 'utf8');
    printHuman(io, `Wrote develop dataset to ${options.out}: ${exported.length} images, ${withDevelop} with develop settings (baseline: ${baseline}).`);
    if (io.json) printJson({ ...dataset, results: [], out: options.out });
  } else if (io.json) {
    printJson(dataset);
  } else {
    printHuman(io, `${exported.length}/${files.length} exported, ${withDevelop} carry develop settings (baseline: ${baseline}). Use --out to write the dataset.`);
  }

  if (withDevelop === 0 && exported.length > 0) {
    logError('No develop settings found on any file — check that XMP sidecars / crs metadata are present.');
    markFailure();
  }
  for (const e of errors) logError(`${e.file}: ${e.error}`);
  if (errors.length > 0) markFailure();
}
