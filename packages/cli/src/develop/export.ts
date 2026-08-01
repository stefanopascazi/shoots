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
import {
  extractColorFeatures,
  COLOR_FEATURE_NAMES,
  readMetadata,
  isRawFile,
  isFloatDng,
  renderFloatDngNeutral,
  type ExifRecord,
} from '@shoots/imaging';
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
  logWarn,
  makeIo,
  markFailure,
  oneLine,
  parsePositiveInt,
  printHuman,
  printJson,
  type CliIo,
} from '../io.js';
import { startPhase, startProgress } from '../progress.js';
import { VERSION } from '../version.js';
import type { AsShotMeta, Treatment } from './develop/schema.js';
import { ensureClipModelReady, ensureExiftoolReady, ensureLibrawReady } from '../tools.js';
// Nothing here knows how an editor stores an edit: the adapter does.
import { DEFAULT_EDITOR, EDITOR_IDS, resolveAdapter } from './adapters/registry.js';

/** Used only when the capture read returned nothing for a file. */
const EMPTY_AS_SHOT: AsShotMeta = {
  tempAsShot: null, tempMeasured: null, tintAsShot: null,
  iso: null, exposureComp: null, camera: null,
};

export const BASELINES = ['embedded-preview', 'external'] as const;
type Baseline = (typeof BASELINES)[number];

export interface DevelopExportOptions {
  model: string;
  concurrency: string;
  out: string;
  baseline: string;
  /** Which editor's develop settings to read (see adapters/registry.ts). */
  editor?: string;
  editedOnly?: boolean;
  json?: boolean;
  verbose?: boolean;
}

/** One record line in the JSONL dataset (baseline lives in the trailing meta line). */
interface DatasetRecord {
  file: string;
  embedding: number[];
  features: number[];
  develop: Record<string, number>;
  asShot: AsShotMeta;
  /** Black-and-white vs colour, read deterministically off the edit (HSL ↔ GrayMixer). */
  treatment: Treatment;
  /** A deliberate edit, not just the neutral defaults the editor writes everywhere. */
  edited: boolean;
  /** Base rendering profile (crs CameraProfile), e.g. "Camera Faithful v2". */
  baseProfile?: string;
  /** Creative profile layered over it (crs Look name), e.g. "Adobe Color". */
  look?: string;
  /** Flattened point tone-curve [x0,y0,x1,y1,…] (ToneCurvePV2012) — the contrast
   *  / black-clipping vehicle, absent when the curve is linear/default. */
  curve?: number[];
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

  const editorId = options.editor ?? DEFAULT_EDITOR;
  if (!EDITOR_IDS.includes(editorId)) {
    logError(`unknown --editor '${editorId}' (available: ${EDITOR_IDS.join(', ')})`);
    process.exitCode = 2;
    return;
  }
  const adapter = resolveAdapter(editorId);

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

  // Develop edits first, from the editor's own store (cheap — sidecars, never
  // the images): needed for ALL files to decide which are edited.
  const crsPhase = startPhase(io, 'Reading develop settings');
  const edits = await adapter.readEdits(files.map((f) => f.path), io, (done, total) => crsPhase.update(`${done}/${total}`));
  crsPhase.done(`${files.length} files`);

  // --edited-only: skip the expensive per-file work (embedding / neutral render /
  // color features) AND the as-shot read for files that were never edited.
  // This is the right default for training-set builds (we train on edited photos
  // only) and avoids opening thousands of large untouched RAWs.
  let untouched = 0;
  let neutral = 0;
  const workFiles = options.editedOnly
    ? files.filter((f) => {
        const edit = edits.get(f.path);
        if (!edit) {
          untouched++;
          return false;
        }
        // Carries develop tags but every predicted target sits at its neutral
        // default — Lightroom wrote them, the photographer did not. Including
        // these teaches the model to predict "change nothing".
        if (!edit.edited) {
          neutral++;
          return false;
        }
        return true;
      })
    : files;
  if (options.editedOnly) {
    // Worth surfacing outside --verbose: this is the number that decides how long
    // the expensive pass will take, and a surprising 0 is the usual mistake.
    printHuman(io, `edited-only: ${workFiles.length}/${files.length} files carry a real edit`);
    if (neutral > 0) {
      printHuman(io, `  skipped ${neutral} with crs defaults only (never actually edited), ${untouched} with no crs at all`);
    }
  }
  if (workFiles.length === 0) {
    printHuman(io, options.editedOnly ? 'No edited files found (crs settings are all at their neutral defaults).' : 'No files to process.');
    return;
  }

  // As-shot EXIF, read from the image files themselves — only for the files we
  // will actually process (opening RAWs is comparatively expensive).
  // Lightroom HDR / panorama merges are floating-point DNGs. No RAW developer
  // can unpack them (LibRaw expects a CFA and reports the file as corrupt), so
  // they are decoded directly from their own scene-linear pyramid. Detect them up
  // front so the per-file work can route accordingly, and so the count is visible.
  const floatDngFiles = new Set<string>();
  const dngCandidates = workFiles.filter((f) => /\.dng$/i.test(f.path));
  if (dngCandidates.length > 0) {
    const dngPhase = startPhase(io, 'Detecting HDR/pano merges');
    for (const [i, f] of dngCandidates.entries()) {
      dngPhase.update(`${i + 1}/${dngCandidates.length}`);
      if (await isFloatDng(f.path)) floatDngFiles.add(f.path);
    }
    dngPhase.done(`${floatDngFiles.size} of ${dngCandidates.length} DNGs are float merges`);
  }

  const exifPhase = startPhase(io, 'Reading capture metadata');
  const capture = await adapter.readCapture(
    workFiles.map((f) => f.path),
    edits,
    io,
    (done, total) => exifPhase.update(`${done}/${total}`),
  );
  exifPhase.done(`${workFiles.length} files`);

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
  /** Distinct Looks seen, name → the editor's own serialization. */
  const looks = new Map<string, string>();

  // Stream each record to disk as it completes (JSONL); return only lightweight
  // counters so nothing is accumulated in memory.
  const outcomes = await queue.run(
    workFiles,
    async (file): Promise<{ hasDevelop: boolean; dim: number }> => {
      // CLIP stays on the embedded preview (semantic, colour-invariant); only the
      // photometric color features move to the neutral render when requested.
      // Float DNGs (Lightroom HDR / panorama merges) carry their own neutral
      // scene-linear pyramid, which no external developer can unpack — decode it
      // directly. That IS the neutral baseline, so it applies under either
      // --baseline mode rather than being tied to the external developer.
      const colorTask = floatDngFiles.has(file.path)
        ? renderFloatDngNeutral(file.path).then((raster) => {
            if (!raster) throw new Error("float DNG decode produced no raster");
            return extractColorFeatures(raster);
          })
        : developer && isRawFile(file.path)
          ? withNeutralRender(developer, file.path, (rendered) => extractColorFeatures(rendered))
          : extractColorFeatures(file.path);
      const [assessment, color] = await Promise.all([model.assess({ path: file.path }), colorTask]);
      if (!assessment.embedding) throw new Error('backend produced no embedding (unsupported model?)');

      const edit = edits.get(file.path);
      const develop = edit?.develop ?? {};
      const record: DatasetRecord = {
        file: file.path,
        embedding: assessment.embedding.map(round5),
        features: color.vector,
        develop,
        asShot: capture.get(file.path) ?? EMPTY_AS_SHOT,
        treatment: edit?.treatment ?? 'color',
        // Carried rather than filtered on: only a real edit is a valid training
        // target, but every frame describes its session. Without the flag the
        // trainer has to guess, and a whole-folder export quietly teaches it to
        // predict "change nothing" from the files the editor merely touched.
        edited: edit?.edited ?? false,
        ...(edit?.baseProfile ? { baseProfile: edit.baseProfile } : {}),
        ...(edit?.look ? { look: edit.look } : {}),
        ...(edit?.curve ? { curve: edit.curve } : {}),
      };
      // The Look element itself goes in the trailing meta line, once per distinct
      // Look — see DevelopDataset.looks.
      if (edit?.look && edit.lookXml) looks.set(edit.look, edit.lookXml);
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
    ...(looks.size > 0 ? { looks: Object.fromEntries(looks) } : {}),
    // Which build extracted these features — `release-notes` compares it against
    // the running version to spot a dataset that a release has left behind.
    toolVersion: VERSION,
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
    // Only a failure when this was meant to be a training set. Exporting
    // untouched RAWs is exactly how you build the input to `develop predict`,
    // so treating "no edits" as an error there rejects the normal path.
    if (options.editedOnly) {
      logError('No develop settings found on any file — check that XMP sidecars / crs metadata are present.');
      markFailure();
    } else {
      printHuman(io, '  (no develop settings on these files — the expected shape of a set to predict on)');
    }
  }
  for (const e of errors) logError(`${e.file}: ${oneLine(e.error)}`);
  if (errors.length > 0) markFailure();
}
