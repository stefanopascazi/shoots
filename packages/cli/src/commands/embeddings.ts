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
 * Output is a single consolidated JSON dataset on stdout (`--json`); no per-file
 * sidecars are ever written — the learning tool consumes the one dataset, and
 * the source folders stay untouched. The `model` name pins the embedding space
 * so a learned profile can guard it later.
 */
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { JobQueue, scanFiles } from '@shoots/core';
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
  parsePositiveInt,
  printHuman,
  printJson,
} from '../io.js';
import { startProgress } from '../progress.js';
import { ensureClipModelReady } from '../tools.js';

interface EmbeddingsOptions {
  model: string;
  concurrency: string;
  out?: string;
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
}

export function registerEmbeddingsCommand(program: Command): void {
  program
    .command('embeddings')
    .description('Export raw CLIP embeddings (profile-neutral) as a consolidated JSON dataset for preference-learning tooling')
    .argument('<path>', 'folder (or single file) to embed')
    .option('--model <kind>', 'inference backend (default: onnx)', 'onnx')
    .option('--concurrency <n>', 'max parallel embedding jobs', '4')
    .option('--out <file>', 'write the dataset to a file instead of stdout')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runEmbeddings);
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

async function runEmbeddings(targetPath: string, options: EmbeddingsOptions): Promise<void> {
  const io = makeIo(options);

  const AVAILABLE_MODELS: ModelKind[] = ['onnx'];
  if (!AVAILABLE_MODELS.includes(options.model as ModelKind)) {
    logError(`unknown inference model '${options.model}' (available: ${AVAILABLE_MODELS.join(', ')})`);
    process.exitCode = 2;
    return;
  }

  // A profile is required to construct the model, but this command consumes only
  // the embedding and the raw aspects — both profile-independent — so the choice
  // of profile does not affect the exported dataset. Use the default.
  const profile = getProfile(DEFAULT_PROFILE_NAME)!;
  const model = createQualityModel(options.model as ModelKind, { profile });

  const files = await scanFiles(targetPath);
  if (files.length === 0) {
    printHuman(io, 'No image files found.');
    if (io.json) printJson({ command: 'embeddings', model: model.name, dim: 0, results: [], summary: { total: 0, embedded: 0, failed: 0 } });
    return;
  }
  logVerbose(io, `Embedding ${files.length} files with model ${model.name}`);

  if (!(await ensureClipModelReady(io))) return;

  await model.init();
  const queue = new JobQueue({ concurrency: parsePositiveInt(options.concurrency, 4) });
  const progress = await startProgress(io, files.length, 'Embedding');

  const outcomes = await queue.run(
    files,
    async (file): Promise<EmbeddingResult> => {
      const assessment = await model.assess({ path: file.path });
      if (!assessment.embedding) {
        throw new Error('backend produced no embedding (unsupported model?)');
      }
      const aspectScores = assessment.aspects.map((a) => a.score);
      return {
        file: file.path,
        embedding: assessment.embedding,
        aspects: assessment.aspects,
        keywords: assessment.keywords,
        focus: Math.round(assessment.focus * 1000) / 1000,
        aestheticSeed: assessment.aspects.length ? Math.round(mean(aspectScores) * 1000) / 1000 : null,
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

  if (options.out) {
    await writeFile(options.out, JSON.stringify(dataset, null, 2) + '\n', 'utf8');
    printHuman(io, `Wrote ${embedded.length} embeddings (dim ${dim}) to ${options.out}`);
    if (io.json) printJson({ ...dataset, results: [], out: options.out });
  } else if (io.json) {
    printJson(dataset);
  } else {
    for (const r of embedded) {
      printHuman(io, `${path.basename(r.file)}  dim=${r.embedding.length}  aspects=${r.aspects.length}  seed=${r.aestheticSeed ?? 'n/a'}  [${r.keywords.join(', ')}]`);
    }
    printHuman(io, `\n${embedded.length}/${files.length} embedded with ${model.name} (dim ${dim})`);
  }

  for (const e of errors) logError(`${e.file}: ${e.error}`);
  if (errors.length > 0) markFailure();
}
