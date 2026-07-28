/**
 * shoots embeddings <path>
 *
 * Feature-extraction export for personal preference learning — deliberately
 * SEPARATE from `rate`. Where `rate` is opinionated (a genre `--profile` shapes
 * the stars), this command is profile-neutral: it emits the raw CLIP image
 * embedding plus the profile-independent per-aspect scores, so a downstream
 * trainer can learn *your* eye "in general" from pairwise duels rather than
 * inheriting any preset's bias.
 *
 * Two output modes:
 *   --json (stdout)  → the consolidated dataset only (embeddings, no previews).
 *   --out <dir>      → a self-contained BUNDLE: <dir>/embeddings.json plus
 *                      <dir>/previews/*.jpg. RAW originals aren't browser-viewable,
 *                      so the bundle carries JPEG previews (embedded RAW preview
 *                      via exiftool, resized with sharp) for the duel UI; each
 *                      result gains a `preview` path relative to the dataset.
 * The `model` name pins the embedding space so a learned profile can guard it.
 */
import path from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import type { Command } from 'commander';
import { JobQueue, scanFiles, type ScannedFile } from '@shoots/core';
import { generateThumbnail, isRawFile } from '@shoots/imaging';
import {
  createQualityModel,
  getProfile,
  DEFAULT_PROFILE_NAME,
  type AestheticAspectScore,
  type ModelKind,
} from '@shoots/inference';
import {
  logError,
  logVerbose,
  makeIo,
  markFailure,
  oneLine,
  parsePositiveInt,
  printHuman,
  printJson,
} from '../io.js';
import { startPhase, startProgress } from '../progress.js';
import { ensureClipModelReady, ensureExiftoolReady } from '../tools.js';

type PreviewMode = 'auto' | 'always' | 'never';
const PREVIEW_MODES: PreviewMode[] = ['auto', 'always', 'never'];

interface EmbeddingsOptions {
  model: string;
  concurrency: string;
  out?: string;
  previews: string;
  previewSize: string;
  previewQuality: string;
  json?: boolean;
  verbose?: boolean;
}

interface EmbeddingResult {
  file: string;
  /** L2-normalized CLIP image embedding (512-d), rounded to 6 decimals. */
  embedding: number[];
  /** Profile-independent per-aspect CLIP scores (composition, exposure, …). */
  aspects: AestheticAspectScore[];
  keywords: string[];
  focus: number;
  /**
   * Neutral aesthetic seed: unweighted mean of {@link aspects}, NOT a profile
   * aggregate. A weak, genre-agnostic starting point for the ranking; null when
   * the archive ships no aesthetics (heuristic fallback, no aspects).
   */
  aestheticSeed: number | null;
  /** Bundle mode only: preview path relative to the dataset (for the duel UI). */
  preview?: string;
}

export function registerEmbeddingsCommand(program: Command): void {
  program
    .command('embeddings')
    .description('Export raw CLIP embeddings (profile-neutral) for preference-learning tooling; --out bundles browser previews for RAW')
    .argument('<path>', 'folder (or single file) to embed')
    .option('--model <kind>', 'inference backend (default: onnx)', 'onnx')
    .option('--concurrency <n>', 'max parallel embedding jobs', '4')
    .option('--out <dir>', 'write a self-contained bundle (embeddings.json + previews/) to this directory')
    .option('--previews <mode>', 'when to generate browser previews in --out mode: auto (RAW only) | always | never', 'auto')
    .option('--preview-size <px>', 'max preview edge in bundle mode', '1024')
    .option('--preview-quality <q>', 'JPEG quality for previews (1-100)', '82')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runEmbeddings);
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Collision-proof, readable preview filename: zero-padded index + safe basename. */
function previewName(index: number, file: ScannedFile, total: number): string {
  const width = String(total).length;
  const base = path.parse(file.name).name.replace(/[^a-zA-Z0-9-_]+/g, '_').slice(0, 60);
  return `${String(index).padStart(width, '0')}_${base}.jpg`;
}

async function runEmbeddings(targetPath: string, options: EmbeddingsOptions): Promise<void> {
  const io = makeIo(options);

  const AVAILABLE_MODELS: ModelKind[] = ['onnx'];
  if (!AVAILABLE_MODELS.includes(options.model as ModelKind)) {
    logError(`unknown inference model '${options.model}' (available: ${AVAILABLE_MODELS.join(', ')})`);
    process.exitCode = 2;
    return;
  }
  if (!PREVIEW_MODES.includes(options.previews as PreviewMode)) {
    logError(`unknown --previews mode '${options.previews}' (available: ${PREVIEW_MODES.join(', ')})`);
    process.exitCode = 2;
    return;
  }
  const previewMode = options.previews as PreviewMode;

  // A profile is required to construct the model, but this command consumes only
  // the embedding and the raw aspects — both profile-independent — so the choice
  // of profile does not affect the exported dataset. Use the default.
  const profile = getProfile(DEFAULT_PROFILE_NAME)!;
  const model = createQualityModel(options.model as ModelKind, { profile });

  const scanPhase = startPhase(io, 'Scanning');
  const files = await scanFiles(targetPath, {
    onProgress: (found) => scanPhase.update(`${found} files`),
  });
  scanPhase.done(`${files.length} files`);
  if (files.length === 0) {
    printHuman(io, 'No image files found.');
    if (io.json) printJson({ command: 'embeddings', model: model.name, dim: 0, results: [], summary: { total: 0, embedded: 0, failed: 0 } });
    return;
  }
  logVerbose(io, `Embedding ${files.length} files with model ${model.name}`);

  if (!(await ensureClipModelReady(io))) return;

  // Bundle mode: decide which files get a browser preview. `auto` previews only
  // RAW (viewable images are referenced directly — the match server falls back to
  // the original path); `always` previews everything; `never` writes just the JSON.
  const bundle = options.out !== undefined;
  const previewsRel = 'previews';
  const previewFor = new Map<string, { rel: string; abs: string }>();
  if (bundle && previewMode !== 'never') {
    const wantsPreview = (f: ScannedFile): boolean => previewMode === 'always' || isRawFile(f.path);
    const targets = files.filter(wantsPreview);
    if (targets.length > 0) {
      // RAW previews come from the embedded JPEG via exiftool (extract + orientation).
      if (targets.some((f) => isRawFile(f.path)) && !(await ensureExiftoolReady(io))) return;
      const previewsDir = path.join(options.out!, previewsRel);
      await mkdir(previewsDir, { recursive: true });
      files.forEach((f, i) => {
        if (!wantsPreview(f)) return;
        const name = previewName(i, f, files.length);
        previewFor.set(f.path, { rel: `${previewsRel}/${name}`, abs: path.join(previewsDir, name) });
      });
    }
  }
  const previewSize = parsePositiveInt(options.previewSize, 1024);
  const previewQuality = parsePositiveInt(options.previewQuality, 82);

  await model.init();
  const queue = new JobQueue({ concurrency: parsePositiveInt(options.concurrency, 4) });
  const progress = await startProgress(io, files.length, previewFor.size > 0 ? 'Embedding + previews' : 'Embedding');

  const outcomes = await queue.run(
    files,
    async (file): Promise<EmbeddingResult> => {
      const assessment = await model.assess({ path: file.path });
      if (!assessment.embedding) {
        throw new Error('backend produced no embedding (unsupported model?)');
      }

      let preview: string | undefined;
      const target = previewFor.get(file.path);
      if (target) {
        await generateThumbnail(file.path, {
          width: previewSize,
          height: previewSize,
          format: 'jpeg',
          quality: previewQuality,
          dest: target.abs,
        });
        preview = target.rel;
      }

      const aspectScores = assessment.aspects.map((a) => a.score);
      return {
        file: file.path,
        embedding: assessment.embedding,
        aspects: assessment.aspects,
        keywords: assessment.keywords,
        focus: Math.round(assessment.focus * 1000) / 1000,
        aestheticSeed: assessment.aspects.length ? Math.round(mean(aspectScores) * 1000) / 1000 : null,
        ...(preview ? { preview } : {}),
      };
    },
    progress.onProgress,
    (file) => file.name,
  );

  progress.stop();
  await model.dispose();

  const embedded = outcomes.filter((o) => o.ok).map((o) => o.value!);
  const errors = outcomes
    .filter((o) => !o.ok)
    .map((o) => ({ file: o.item.path, error: o.error?.message ?? 'unknown error' }));

  const dim = embedded[0]?.embedding.length ?? 0;
  const dataset = {
    command: 'embeddings' as const,
    model: model.name,
    dim,
    results: embedded,
    errors,
    summary: { total: files.length, embedded: embedded.length, failed: errors.length },
  };

  if (bundle) {
    await mkdir(options.out!, { recursive: true });
    const jsonPath = path.join(options.out!, 'embeddings.json');
    await writeFile(jsonPath, JSON.stringify(dataset, null, 2) + '\n', 'utf8');
    const previewCount = embedded.filter((r) => r.preview).length;
    const previewNote = previewCount > 0 ? `${previewCount} previews in ${previewsRel}/` : `no previews (--previews ${previewMode})`;
    printHuman(io, `Wrote bundle to ${options.out}: embeddings.json + ${previewNote} (dim ${dim})`);
    if (io.json) printJson({ ...dataset, results: [], out: options.out, previews: previewCount > 0 ? previewsRel : null });
  } else if (io.json) {
    printJson(dataset);
  } else {
    for (const r of embedded) {
      printHuman(io, `${path.basename(r.file)}  dim=${r.embedding.length}  aspects=${r.aspects.length}  seed=${r.aestheticSeed ?? 'n/a'}  [${r.keywords.join(', ')}]`);
    }
    printHuman(io, `\n${embedded.length}/${files.length} embedded with ${model.name} (dim ${dim})`);
  }

  for (const e of errors) logError(`${e.file}: ${oneLine(e.error)}`);
  if (errors.length > 0) markFailure();
}
