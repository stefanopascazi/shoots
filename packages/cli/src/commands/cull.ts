/**
 * shoots cull <path>
 *
 * Classic Laplacian-variance blur detection over a folder of RAW/JPG/PNG
 * files (RAW files are analyzed via their embedded JPEG preview). Produces a
 * JSON/CSV report and can optionally COPY files into sharp/ and blurry/
 * subfolders. Strictly non-destructive: originals are never touched.
 */
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { JobQueue, scanFiles } from '@shoots/core';
import {
  analyzeBlur,
  DEFAULT_BLUR_THRESHOLD,
  DEFAULT_FOCUS_THRESHOLD,
  readMetadata,
  type BlurAnalysis,
} from '@shoots/imaging';
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

interface CullOptions {
  threshold: string;
  focusThreshold: string;
  focusRescue?: boolean;
  separate?: boolean;
  dest?: string;
  format: string;
  out?: string;
  concurrency: string;
  dryRun?: boolean;
  json?: boolean;
  verbose?: boolean;
}

export function registerCullCommand(program: Command): void {
  program
    .command('cull')
    .description('Detect blurry shots via Laplacian variance, focus-aware to spare shallow-DoF keepers; report and optionally separate sharp/blurry (never deletes)')
    .argument('<path>', 'folder (or single file) to analyze')
    .option('--threshold <n>', 'global Laplacian variance below this = blurry', String(DEFAULT_BLUR_THRESHOLD))
    .option('--focus-threshold <n>', 'keep a globally-soft frame if its sharpest region scores above this (rescues shallow depth of field)', String(DEFAULT_FOCUS_THRESHOLD))
    .option('--no-focus-rescue', 'disable the shallow-DoF rescue and classify purely on the global score')
    .option('--separate', 'copy files into sharp/ and blurry/ subfolders of --dest')
    .option('--dest <dir>', 'destination for --separate (default: <path>/_culled)')
    .option('--format <fmt>', 'report format: json | csv', 'json')
    .option('--out <file>', 'write the report to a file instead of stdout')
    .option('--concurrency <n>', 'max parallel analyses', '4')
    .option('--dry-run', 'analyze and report, but skip copying and report-file writes')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runCull);
}

interface CullError {
  file: string;
  error: string;
}

async function runCull(targetPath: string, options: CullOptions): Promise<void> {
  const io = makeIo(options);
  const threshold = Number.parseFloat(options.threshold);
  if (!Number.isFinite(threshold) || threshold <= 0) {
    logError(`Invalid --threshold: ${options.threshold}`);
    process.exitCode = 2;
    return;
  }
  const focusThreshold = Number.parseFloat(options.focusThreshold);
  if (!Number.isFinite(focusThreshold) || focusThreshold < 0) {
    logError(`Invalid --focus-threshold: ${options.focusThreshold}`);
    process.exitCode = 2;
    return;
  }
  const focusRescue = options.focusRescue !== false;
  if (options.format !== 'json' && options.format !== 'csv') {
    logError(`Invalid --format: ${options.format} (expected json or csv)`);
    process.exitCode = 2;
    return;
  }

  // Destination for --separate; resolved up front so we can keep it out of the
  // scan. scanFiles recurses and the default dest lives inside the target, so
  // re-running --separate would otherwise re-analyze the sharp/ and blurry/ copies.
  const destRoot = path.resolve(options.dest ?? path.join(targetPath, '_culled'));
  const destPrefix = destRoot + path.sep;
  const scanned = await scanFiles(targetPath);
  const files = options.separate
    ? scanned.filter((f) => f.path !== destRoot && !f.path.startsWith(destPrefix))
    : scanned;
  if (files.length === 0) {
    printHuman(io, 'No image files found.');
    if (io.json) printJson({ command: 'cull', threshold, results: [], errors: [], summary: { total: 0, sharp: 0, blurry: 0, failed: 0 } });
    return;
  }
  logVerbose(
    io,
    `Analyzing ${files.length} files (threshold ${threshold}, focus ${focusRescue ? focusThreshold : 'off'})`,
  );

  // RAW files are analyzed via their embedded JPEG preview, extracted with
  // exiftool; only provision it when the batch actually contains RAW.
  if (files.some((f) => f.kind === 'raw') && !(await ensureExiftoolReady(io))) return;

  const queue = new JobQueue({ concurrency: parsePositiveInt(options.concurrency, 4) });
  const progress = await startProgress(io, files.length, 'Culling');

  const outcomes = await queue.run(
    files,
    (file) => analyzeBlur(file.path, { threshold, focusThreshold, focusRescue }),
    progress.onProgress,
    (file) => file.name,
  );

  progress.stop();

  const results: BlurAnalysis[] = [];
  const errors: CullError[] = [];
  for (const o of outcomes) {
    if (o.ok && o.value) results.push(o.value);
    else errors.push({ file: o.item.path, error: o.error?.message ?? 'unknown error' });
  }
  const sharp = results.filter((r) => r.verdict === 'sharp');
  const blurry = results.filter((r) => r.verdict === 'blurry');
  const rescued = results.filter((r) => r.rescued);

  // ---- aperture context (EXIF FNumber), best-effort ----
  // Reported alongside the scores so borderline/rescued frames can be judged:
  // a low global score at a narrow aperture means something different than at
  // f/1.4. Needs exiftool (already ensured for RAW batches); if it isn't
  // available we simply omit the column rather than failing the cull.
  const apertureByFile = await readApertures(io, files.map((f) => f.path));

  // ---- optional separation (copies only, originals untouched) ----
  const copied: { source: string; dest: string }[] = [];
  if (options.separate && !options.dryRun) {
    await mkdir(path.join(destRoot, 'sharp'), { recursive: true });
    await mkdir(path.join(destRoot, 'blurry'), { recursive: true });
    for (const result of results) {
      const dest = path.join(destRoot, result.verdict, path.basename(result.file));
      try {
        await copyFile(result.file, dest);
        copied.push({ source: result.file, dest });
      } catch (err) {
        errors.push({ file: result.file, error: `copy failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    logVerbose(io, `Copied ${copied.length} files under ${destRoot}`);
  }

  // ---- report ----
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  const report = {
    command: 'cull',
    threshold,
    focusThreshold,
    focusRescue,
    dryRun: !!options.dryRun,
    results: results.map((r) => ({
      file: r.file,
      score: round2(r.score),
      focusPeak: round2(r.focusPeak),
      verdict: r.verdict,
      rescued: r.rescued,
      aperture: apertureByFile.get(normalizePath(r.file)) ?? null,
      pixelSource: r.pixelSource,
    })),
    errors,
    separated: options.separate ? { dest: destRoot, copied: copied.length, planned: options.dryRun ? results.length : undefined } : undefined,
    summary: { total: files.length, sharp: sharp.length, blurry: blurry.length, rescued: rescued.length, failed: errors.length },
  };

  const reportText =
    options.format === 'csv'
      ? toCsv(report.results)
      : JSON.stringify(report, null, 2);

  if (options.out && !options.dryRun) {
    await writeFile(options.out, reportText + '\n', 'utf8');
    logVerbose(io, `Report written to ${options.out}`);
  }

  if (io.json) {
    printJson(report);
  } else if (options.out && !options.dryRun) {
    printHuman(io, `Report written to ${options.out}`);
    printHuman(io, summaryLine(report.summary, threshold));
  } else if (options.format === 'csv') {
    printHuman(io, reportText);
    printHuman(io, '');
    printHuman(io, summaryLine(report.summary, threshold));
  } else {
    printHuman(io, `${'verdict'.padEnd(7)}  ${'score'.padStart(10)}  ${'focus'.padStart(10)}  ${'aper'.padStart(6)}  file`);
    for (const r of report.results) {
      const tag = r.verdict === 'blurry' ? 'blurry' : r.rescued ? 'sharp*' : 'sharp';
      const aper = r.aperture ? `f/${r.aperture}` : '—';
      printHuman(io, `${tag.padEnd(7)}  ${String(r.score).padStart(10)}  ${String(r.focusPeak).padStart(10)}  ${aper.padStart(6)}  ${r.file}`);
    }
    printHuman(io, '');
    printHuman(io, summaryLine(report.summary, threshold));
    if (rescued.length > 0) {
      printHuman(io, `  sharp* = subject in focus despite a soft frame (shallow DoF), kept via --focus-threshold ${focusThreshold}`);
    }
    if (options.separate && options.dryRun) {
      printHuman(io, `(dry run) files would be copied into ${destRoot}\\sharp and \\blurry`);
    } else if (options.separate) {
      printHuman(io, `Copied ${copied.length} files into ${destRoot}`);
    }
  }

  for (const e of errors) logError(`${e.file}: ${e.error}`);
  if (errors.length > 0) markFailure();
}

function summaryLine(
  summary: { total: number; sharp: number; blurry: number; rescued: number; failed: number },
  threshold: number,
): string {
  const rescued = summary.rescued > 0 ? ` (${summary.rescued} rescued)` : '';
  return `${summary.total} analyzed @ threshold ${threshold}: ${summary.sharp} sharp${rescued}, ${summary.blurry} blurry, ${summary.failed} failed`;
}

function toCsv(
  rows: {
    file: string;
    score: number;
    focusPeak: number;
    verdict: string;
    rescued: boolean;
    aperture: number | null;
    pixelSource: string;
  }[],
): string {
  const escape = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = ['file,score,focus_peak,verdict,rescued,aperture,pixel_source'];
  for (const row of rows) {
    lines.push(
      `${escape(row.file)},${row.score},${row.focusPeak},${row.verdict},${row.rescued},${row.aperture ?? ''},${row.pixelSource}`,
    );
  }
  return lines.join('\n');
}

/** Slash-normalized path key so exiftool's SourceFile matches our file paths. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Batch-read the aperture (EXIF FNumber) for a set of files. Best-effort: any
 * failure (exiftool missing, unreadable files) yields an empty map rather than
 * aborting the cull — aperture is report context, not a decision input.
 */
async function readApertures(io: ReturnType<typeof makeIo>, files: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const records = await readMetadata(files, { tags: ['FNumber'] });
    for (const rec of records) {
      const raw = rec.FNumber;
      const f = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''));
      if (Number.isFinite(f)) map.set(normalizePath(rec.SourceFile), f);
    }
  } catch (err) {
    logVerbose(io, `Aperture unavailable (exiftool): ${err instanceof Error ? err.message : String(err)}`);
  }
  return map;
}
