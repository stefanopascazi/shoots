/**
 * shoots cull <path>
 *
 * Classic Laplacian-variance blur detection over a folder of RAW/JPG/PNG
 * files (RAW files are analyzed via their embedded JPEG preview). Produces a
 * JSON/CSV report and can optionally COPY files into sharp/ and blurry/
 * subfolders. Strictly non-destructive: originals are never touched.
 */
import { statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
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
  oneLine,
  parsePositiveInt,
  printHuman,
  printJson,
} from '../io.js';
import { startPhase, startProgress } from '../progress.js';
import { relocate } from '../relocate.js';
import { ensureExiftoolReady } from '../tools.js';
import { TriageStore } from '../triage/store.js';
import { isSemanticLabel, SEMANTIC_LABELS, type SemanticLabel } from '../triage/schema.js';
import { VERSION } from '../version.js';

interface CullOptions {
  threshold: string;
  focusThreshold: string;
  focusRescue?: boolean;
  dest?: string;
  copy?: boolean;
  mark?: boolean;
  markLabel: string;
  markKeepers?: string;
  format: string;
  out?: string;
  concurrency: string;
  dryRun?: boolean;
  json?: boolean;
  verbose?: boolean;
  review?: boolean;
}

export function registerCullCommand(program: Command): void {
  program
    .command('cull')
    .description('Detect blurry shots via Laplacian variance, focus-aware to spare shallow-DoF keepers; keepers stay put, rejects go to --dest mirroring the source structure')
    .argument('<path>', 'folder (or single file) to analyze')
    .option('--threshold <n>', 'global Laplacian variance below this = blurry', String(DEFAULT_BLUR_THRESHOLD))
    .option('--focus-threshold <n>', 'keep a globally-soft frame if its sharpest region scores above this (rescues shallow depth of field)', String(DEFAULT_FOCUS_THRESHOLD))
    .option('--no-focus-rescue', 'disable the shallow-DoF rescue and classify purely on the global score')
    .option('--dest <dir>', 'move blurry rejects here, mirroring the source folder structure (keepers are never touched)')
    .option('--copy', 'copy rejects to --dest instead of moving them (leaves the originals in place)')
    .option('--mark', 'record the verdict as a triage mark instead of moving anything; `develop edit` or `triage apply` writes it into a sidecar later')
    .option('--mark-label <name>', `semantic label for rejects: ${SEMANTIC_LABELS.join(' | ')}`, 'reject')
    .option('--mark-keepers <name>', `also label the keepers: ${SEMANTIC_LABELS.join(' | ')}`)
    .option('--format <fmt>', 'report format: json | csv', 'json')
    .option('--out <file>', 'write the report to a file instead of stdout')
    .option('--concurrency <n>', 'max parallel analyses', '4')
    .option('--dry-run', 'analyze and report, but skip copying and report-file writes')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .option('--review', 'interactively review the uncertain (shallow-DoF) shots — available only inside the `shoots` shell')
    .action(runCull);
}

interface CullError {
  file: string;
  error: string;
}

async function runCull(targetPath: string, options: CullOptions): Promise<void> {
  const io = makeIo(options);
  // --review is an interactive mode that only the shell can host (it owns the
  // Ink terminal). Reaching runCull with it set means a plain batch invocation.
  if (options.review) {
    logError('--review needs the interactive shell: run `shoots`, then `/cull <path> --review`');
    process.exitCode = 2;
    return;
  }
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
  if (!isSemanticLabel(options.markLabel)) {
    logError(`Invalid --mark-label: ${options.markLabel} (expected one of: ${SEMANTIC_LABELS.join(', ')})`);
    process.exitCode = 2;
    return;
  }
  if (options.markKeepers !== undefined && !isSemanticLabel(options.markKeepers)) {
    logError(`Invalid --mark-keepers: ${options.markKeepers} (expected one of: ${SEMANTIC_LABELS.join(', ')})`);
    process.exitCode = 2;
    return;
  }
  const rejectLabel = options.markLabel as SemanticLabel;
  const keeperLabel = options.markKeepers as SemanticLabel | undefined;
  if (options.out) {
    // --out must name a file. A common slip is pointing it at an existing
    // directory, which would surface as a raw EISDIR from writeFile.
    try {
      if (statSync(path.resolve(options.out)).isDirectory()) {
        logError(`--out points to a directory, not a file: ${path.resolve(options.out)}`);
        process.exitCode = 2;
        return;
      }
    } catch {
      // path doesn't exist yet — writeFile will create it
    }
  }

  // Rejects go here (mirroring the source structure); keepers are never moved.
  // Resolve up front and keep it out of the scan: scanFiles recurses, so if
  // --dest sits inside the target a second run would re-analyze relocated files.
  const destRoot = options.dest ? path.resolve(options.dest) : undefined;
  // Root the mirror at the scanned folder; a single-file target mirrors by basename.
  const scanRoot = statSync(targetPath).isDirectory()
    ? path.resolve(targetPath)
    : path.dirname(path.resolve(targetPath));
  const scanPhase = startPhase(io, 'Scanning');
  const scanned = await scanFiles(targetPath, {
    onProgress: (found) => scanPhase.update(`${found} files`),
  });
  scanPhase.done(`${scanned.length} files`);
  const files = destRoot
    ? scanned.filter((f) => f.path !== destRoot && !f.path.startsWith(destRoot + path.sep))
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

  const round2 = (n: number): number => Math.round(n * 100) / 100;

  // ---- record the verdict as a triage mark (--mark) ----
  // Nothing is written next to the photographs: the verdict lands in the store
  // under ~/.shoots/triage and waits for a writer (`develop edit` or `triage
  // apply`) to render it in the target editor's own label vocabulary. Marking
  // runs before the relocation below so a reject that then moves has marks to
  // carry with it.
  let marked = 0;
  if (options.mark && !options.dryRun) {
    const store = await TriageStore.open(scanRoot);
    const tool = `cull@${VERSION}`;
    for (const result of results) {
      const isReject = result.verdict === 'blurry';
      if (!isReject && !keeperLabel) continue;
      await store.mark(
        result.file,
        isReject
          ? { reject: true, label: rejectLabel }
          : { reject: false, label: keeperLabel },
        'cull',
        {
          tool,
          verdict: result.verdict,
          score: round2(result.score),
          focusPeak: round2(result.focusPeak),
          rescued: result.rescued,
          threshold,
          focusThreshold: focusRescue ? focusThreshold : null,
        },
      );
      marked++;
    }
    await store.save();
    logVerbose(io, `Marked ${marked} files in ${store.storePath}`);
  }

  // ---- relocate rejects (blurry) to --dest, mirroring the source structure ----
  // Keepers (sharp, incl. shallow-DoF rescues) are never touched. Move by
  // default; --copy leaves the originals in place. Requires --dest.
  const move = !options.copy;
  const relocated: { source: string; dest: string }[] = [];
  if (destRoot && !options.dryRun) {
    for (const result of blurry) {
      try {
        const to = await relocate(scanRoot, result.file, destRoot, { move });
        relocated.push({ source: result.file, dest: to });
      } catch (err) {
        errors.push({ file: result.file, error: `${move ? 'move' : 'copy'} failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    logVerbose(io, `${move ? 'Moved' : 'Copied'} ${relocated.length} rejects under ${destRoot}`);
  }

  // ---- report ----
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
    relocated: destRoot
      ? {
          dest: destRoot,
          mode: move ? 'move' : 'copy',
          count: options.dryRun ? blurry.length : relocated.length,
          planned: options.dryRun,
        }
      : undefined,
    marked: options.mark
      ? {
          label: rejectLabel,
          keepersLabel: keeperLabel ?? null,
          count: options.dryRun ? (keeperLabel ? results.length : blurry.length) : marked,
          planned: !!options.dryRun,
        }
      : undefined,
    summary: { total: files.length, sharp: sharp.length, blurry: blurry.length, rescued: rescued.length, failed: errors.length },
  };

  const reportText =
    options.format === 'csv'
      ? toCsv(report.results)
      : JSON.stringify(report, null, 2);

  if (options.out && !options.dryRun) {
    try {
      await writeFile(options.out, reportText + '\n', 'utf8');
      logVerbose(io, `Report written to ${options.out}`);
    } catch (err) {
      logError(`Failed to write --out ${options.out}: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
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
    if (destRoot) {
      const verb = move ? 'moved' : 'copied';
      printHuman(
        io,
        options.dryRun
          ? `(dry run) ${blurry.length} rejects would be ${verb} into ${destRoot} (mirroring structure); keepers stay put`
          : `${verb} ${relocated.length} rejects into ${destRoot} (mirroring structure); keepers left in place`,
      );
    }
    if (options.mark) {
      const scope = keeperLabel ? `rejects '${rejectLabel}', keepers '${keeperLabel}'` : `rejects '${rejectLabel}'`;
      printHuman(
        io,
        options.dryRun
          ? `(dry run) would mark ${scope}; nothing is written next to the photographs`
          : `marked ${marked} files (${scope}) — \`shoots develop edit\` or \`shoots triage apply\` writes them into sidecars`,
      );
    }
  }

  for (const e of errors) logError(`${e.file}: ${oneLine(e.error)}`);
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
