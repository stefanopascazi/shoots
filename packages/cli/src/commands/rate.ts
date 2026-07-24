/**
 * shoots rate <path>
 *
 * End-to-end wiring of the @shoots/inference QualityModel seam: score each
 * image (focus + aesthetic + keyword suggestions via the deterministic stub
 * model for now), derive a 1–5 star rating, and persist as either:
 *   - a JSON sidecar `<file>.shoots.json` (default), or
 *   - an XMP sidecar `<file-minus-ext>.xmp` written via exiftool (--write-xmp)
 * Original files are never modified.
 */
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { JobQueue, scanFiles } from '@shoots/core';
import { writeXmpSidecar } from '@shoots/imaging';
import { createQualityModel, toStarRating, type ModelKind } from '@shoots/inference';
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
import { ensureExiftoolReady } from '../tools.js';

interface RateOptions {
  model: string;
  writeXmp?: boolean;
  concurrency: string;
  dryRun?: boolean;
  json?: boolean;
  verbose?: boolean;
}

interface RatingResult {
  file: string;
  stars: number;
  focus: number;
  aesthetic: number;
  keywords: string[];
  sidecar: string | null;
  model: string;
}

export function registerRateCommand(program: Command): void {
  program
    .command('rate')
    .description('Score images (focus/aesthetic/keywords) via the inference model and write star ratings to sidecars')
    .argument('<path>', 'folder (or single file) to rate')
    .option('--model <kind>', 'inference backend: stub | onnx (onnx not implemented yet)', 'stub')
    .option('--write-xmp', 'write XMP sidecars via exiftool instead of JSON sidecars')
    .option('--concurrency <n>', 'max parallel scoring jobs', '4')
    .option('--dry-run', 'score and report, but write no sidecars')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runRate);
}

async function runRate(targetPath: string, options: RateOptions): Promise<void> {
  const io = makeIo(options);

  let model;
  try {
    model = createQualityModel(options.model as ModelKind);
  } catch (err) {
    logError(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
    return;
  }

  const files = await scanFiles(targetPath);
  if (files.length === 0) {
    printHuman(io, 'No image files found.');
    if (io.json) printJson({ command: 'rate', model: model.name, results: [], summary: { total: 0, rated: 0, failed: 0 } });
    return;
  }
  logVerbose(io, `Rating ${files.length} files with model ${model.name}`);

  // XMP sidecars are written via exiftool; JSON sidecars need nothing extra.
  if (options.writeXmp && !(await ensureExiftoolReady(io))) return;

  await model.init();
  const queue = new JobQueue({ concurrency: parsePositiveInt(options.concurrency, 4) });
  const progress = await startProgress(io, files.length, 'Rating');

  const outcomes = await queue.run(
    files,
    async (file): Promise<RatingResult> => {
      const assessment = await model.assess({ path: file.path });
      const stars = toStarRating(assessment);

      let sidecar: string | null = null;
      if (!options.dryRun) {
        if (options.writeXmp) {
          const parsed = path.parse(file.path);
          const xmpPath = path.join(parsed.dir, `${parsed.name}.xmp`);
          if (existsSync(xmpPath)) {
            throw new Error(`XMP sidecar already exists, refusing to overwrite: ${xmpPath}`);
          }
          await writeXmpSidecar(file.path, xmpPath, {
            'XMP:Rating': stars,
            'XMP:Subject': assessment.keywords,
          });
          sidecar = xmpPath;
        } else {
          const jsonPath = `${file.path}.shoots.json`;
          await writeFile(
            jsonPath,
            JSON.stringify(
              {
                file: file.path,
                model: model.name,
                stars,
                scores: { focus: assessment.focus, aesthetic: assessment.aesthetic },
                keywords: assessment.keywords,
                generatedAt: new Date().toISOString(),
              },
              null,
              2,
            ) + '\n',
            'utf8',
          );
          sidecar = jsonPath;
        }
      }

      return {
        file: file.path,
        stars,
        focus: Math.round(assessment.focus * 1000) / 1000,
        aesthetic: Math.round(assessment.aesthetic * 1000) / 1000,
        keywords: assessment.keywords,
        sidecar,
        model: model.name,
      };
    },
    progress.onProgress,
    (file) => file.name,
  );

  progress.stop();
  await model.dispose();

  const rated = outcomes.filter((o) => o.ok).map((o) => o.value!);
  const errors = outcomes
    .filter((o) => !o.ok)
    .map((o) => ({ file: o.item.path, error: o.error?.message ?? 'unknown error' }));

  if (io.json) {
    printJson({
      command: 'rate',
      model: model.name,
      dryRun: !!options.dryRun,
      results: rated,
      errors,
      summary: { total: files.length, rated: rated.length, failed: errors.length },
    });
  } else {
    for (const r of rated) {
      const starsBar = '★'.repeat(r.stars) + '☆'.repeat(5 - r.stars);
      printHuman(io, `${starsBar}  ${path.basename(r.file)}  focus=${r.focus} aesthetic=${r.aesthetic}  [${r.keywords.join(', ')}]`);
    }
    printHuman(io, `\n${rated.length}/${files.length} rated with ${model.name}${options.dryRun ? ' (dry run, no sidecars written)' : ''}`);
  }
  for (const e of errors) logError(`${e.file}: ${e.error}`);
  if (errors.length > 0) markFailure();
}
