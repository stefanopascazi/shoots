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
import { analyzeBlur, DEFAULT_BLUR_THRESHOLD, type BlurAnalysis } from '@shoots/imaging';
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

interface CullOptions {
  threshold: string;
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
    .description('Detect blurry shots via Laplacian variance; report and optionally separate sharp/blurry (never deletes)')
    .argument('<path>', 'folder (or single file) to analyze')
    .option('--threshold <n>', 'Laplacian variance below this = blurry', String(DEFAULT_BLUR_THRESHOLD))
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
  if (options.format !== 'json' && options.format !== 'csv') {
    logError(`Invalid --format: ${options.format} (expected json or csv)`);
    process.exitCode = 2;
    return;
  }

  const files = await scanFiles(targetPath);
  if (files.length === 0) {
    printHuman(io, 'No image files found.');
    if (io.json) printJson({ command: 'cull', threshold, results: [], errors: [], summary: { total: 0, sharp: 0, blurry: 0, failed: 0 } });
    return;
  }
  logVerbose(io, `Analyzing ${files.length} files (threshold ${threshold})`);

  const queue = new JobQueue({ concurrency: parsePositiveInt(options.concurrency, 4) });
  const progress = await startProgress(io, files.length, 'Culling');

  const outcomes = await queue.run(
    files,
    (file) => analyzeBlur(file.path, { threshold }),
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

  // ---- optional separation (copies only, originals untouched) ----
  const destRoot = path.resolve(options.dest ?? path.join(targetPath, '_culled'));
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
  const report = {
    command: 'cull',
    threshold,
    dryRun: !!options.dryRun,
    results: results.map((r) => ({
      file: r.file,
      score: Math.round(r.score * 100) / 100,
      verdict: r.verdict,
      pixelSource: r.pixelSource,
    })),
    errors,
    separated: options.separate ? { dest: destRoot, copied: copied.length, planned: options.dryRun ? results.length : undefined } : undefined,
    summary: { total: files.length, sharp: sharp.length, blurry: blurry.length, failed: errors.length },
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
    for (const r of report.results) {
      printHuman(io, `${r.verdict === 'sharp' ? 'sharp ' : 'blurry'}  ${String(r.score).padStart(10)}  ${r.file}`);
    }
    printHuman(io, '');
    printHuman(io, summaryLine(report.summary, threshold));
    if (options.separate && options.dryRun) {
      printHuman(io, `(dry run) files would be copied into ${destRoot}\\sharp and \\blurry`);
    } else if (options.separate) {
      printHuman(io, `Copied ${copied.length} files into ${destRoot}`);
    }
  }

  for (const e of errors) logError(`${e.file}: ${e.error}`);
  if (errors.length > 0) markFailure();
}

function summaryLine(summary: { total: number; sharp: number; blurry: number; failed: number }, threshold: number): string {
  return `${summary.total} analyzed @ threshold ${threshold}: ${summary.sharp} sharp, ${summary.blurry} blurry, ${summary.failed} failed`;
}

function toCsv(rows: { file: string; score: number; verdict: string; pixelSource: string }[]): string {
  const escape = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = ['file,score,verdict,pixel_source'];
  for (const row of rows) {
    lines.push(`${escape(row.file)},${row.score},${row.verdict},${row.pixelSource}`);
  }
  return lines.join('\n');
}
