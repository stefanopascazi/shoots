/**
 * shoots cull <path> | --files-from <list>
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
import { defaultImageConcurrency, JobQueue } from '@shoots/core';
import {
  DEFAULT_BLUR_THRESHOLD,
  DEFAULT_FOCUS_THRESHOLD,
  readMetadata,
  type BlurAnalysis,
} from '@shoots/imaging';
import { DerivedCache } from '../cache/store.js';
import { reportFocusMap } from '../focusMap.js';
import { analyzeBlurCached } from '../cache/blur.js';
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
import { relocateAll } from '../relocate.js';
import { ensureExiftoolReady } from '../tools.js';
import { TriageStore } from '../triage/store.js';
import { resolveTargets, skippedAsError } from '../targets.js';
import { isSemanticLabel, SEMANTIC_LABELS, type SemanticLabel } from '../triage/schema.js';
import { VERSION } from '../version.js';

interface CullOptions {
  threshold: string;
  focusThreshold: string;
  focusRescue?: boolean;
  filesFrom?: string;
  dest?: string;
  copy?: boolean;
  mark?: boolean;
  markLabel: string;
  markKeepers?: string;
  format: string;
  out?: string;
  concurrency: string;
  cache?: boolean;
  dryRun?: boolean;
  json?: boolean;
  verbose?: boolean;
  review?: boolean;
}

export function registerCullCommand(program: Command): void {
  program
    .command('cull')
    .description('Detect blurry shots via Laplacian variance, focus-aware to spare shallow-DoF keepers; keepers stay put, rejects go to --dest mirroring the source structure')
    .argument('[path]', 'folder (or single file) to analyze')
    .option('--files-from <list>', 'analyze exactly the files listed in this text file, one path per line, instead of scanning <path>')
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
    .option('--concurrency <n>', 'max parallel analyses', String(defaultImageConcurrency()))
    .option('--no-cache', 're-measure every frame instead of reusing what a previous run worked out')
    .option('--dry-run', 'analyze and report, but skip copying and report-file writes')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .option('--review', 'deprecated: review the verdicts in the shoots app (Lightroom › Plug-in Extras › Open shoots); still works inside the `shoots` shell')
    .action(runCull);
}

interface CullError {
  file: string;
  error: string;
}

async function runCull(targetPath: string | undefined, options: CullOptions): Promise<void> {
  const io = makeIo(options);
  // --review is an interactive mode that only the shell can host (it owns the
  // Ink terminal). Reaching runCull with it set means a plain batch invocation.
  if (options.review) {
    logError('--review needs the interactive shell and is deprecated: review the verdicts in the shoots app (Lightroom › Plug-in Extras › Open shoots), or run `shoots`, then `/cull <path> --review --mark`');
    process.exitCode = 2;
    return;
  }
  // --mark and --dest answer the same question two ways (record the verdict vs
  // act on it) and do compose, but `--copy` only means something to a relocation.
  if (options.copy && !options.dest) {
    logError('--copy has no meaning without --dest (it chooses copy over move for the relocated rejects)');
    process.exitCode = 2;
    return;
  }
  // Both mirror or store relative to a scanned folder, which a list does not have.
  if (options.filesFrom && (options.dest || options.mark)) {
    logError(`${options.dest ? '--dest' : '--mark'} needs a <path>: --files-from names files, not the folder they are relative to`);
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
  const scanPhase = startPhase(io, 'Scanning');
  const resolved = await resolveTargets(targetPath, options.filesFrom, (found) => scanPhase.update(`${found} files`));
  if (!resolved.ok) {
    scanPhase.done('');
    logError(resolved.error);
    process.exitCode = 2;
    return;
  }
  const { files: scanned, skipped } = resolved.targets;
  // Only --mark and --dest read it, and both are refused with --files-from above.
  const scanRoot = targetPath
    ? statSync(targetPath).isDirectory()
      ? path.resolve(targetPath)
      : path.dirname(path.resolve(targetPath))
    : '';
  scanPhase.done(`${scanned.length} files`);
  const files = destRoot
    ? scanned.filter((f) => f.path !== destRoot && !f.path.startsWith(destRoot + path.sep))
    : scanned;
  if (files.length === 0) {
    printHuman(io, 'No image files found.');
    const skippedErrors = skipped.map(skippedAsError);
    if (io.json) {
      printJson({
        command: 'cull',
        threshold,
        results: [],
        errors: skippedErrors,
        summary: { total: skipped.length, sharp: 0, blurry: 0, failed: skipped.length },
      });
    }
    for (const e of skippedErrors) logError(`${e.file}: ${e.error}`);
    if (skipped.length > 0) markFailure();
    return;
  }
  logVerbose(
    io,
    `Analyzing ${files.length} files (threshold ${threshold}, focus ${focusRescue ? focusThreshold : 'off'})`,
  );

  // RAW files are analyzed via their embedded JPEG preview, extracted with
  // exiftool; only provision it when the batch actually contains RAW.
  if (files.some((f) => f.kind === 'raw') && !(await ensureExiftoolReady(io))) return;

  // The measurement is expensive and threshold-independent; the verdict is
  // arithmetic over it. Caching only the first half is what makes re-running
  // with a different --threshold cost nothing.
  const cache = await DerivedCache.open(
    files.map((f) => f.path),
    { enabled: options.cache !== false },
  );

  const queue = new JobQueue({ concurrency: parsePositiveInt(options.concurrency, defaultImageConcurrency()) });
  const progress = await startProgress(io, files.length, 'Culling');

  const outcomes = await queue.run(
    files,
    (file) => analyzeBlurCached(cache, file, { threshold, focusThreshold, focusRescue }),
    progress.onProgress,
    (file) => file.name,
  );

  progress.stop();
  await cache.save();
  logVerbose(
    io,
    `Cache: ${cache.counters.hits} hits, ${cache.counters.misses} misses, ${cache.counters.stale} stale`,
  );

  const results: BlurAnalysis[] = [];
  const errors: CullError[] = skipped.map(skippedAsError);
  for (const o of outcomes) {
    if (o.ok && o.value) results.push(o.value);
    else errors.push({ file: o.item.path, error: o.error?.message ?? 'unknown error' });
  }
  const sharp = results.filter((r) => r.verdict === 'sharp');
  const blurry = results.filter((r) => r.verdict === 'blurry');
  const rescued = results.filter((r) => r.rescued);

  // ---- frame context (EXIF FNumber, Orientation), best-effort ----
  // Aperture is reported alongside the scores so borderline/rescued frames can
  // be judged: a low global score at a narrow aperture means something different
  // than at f/1.4. Orientation turns the focus map upright. Needs exiftool
  // (already ensured for RAW batches); if it isn't available the aperture is
  // omitted and the map stays as measured, rather than failing the cull.
  const contextByFile = await readFrameContext(io, files.map((f) => f.path));

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
    // The scan already reported each file's size and mtime; handing them over
    // spares the store a stat per photograph, which on a network catalog is the
    // whole cost of marking.
    const statsByFile = new Map(files.map((f) => [f.path, { size: f.size, mtimeMs: f.mtime.getTime() }]));
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
        statsByFile.get(result.file),
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
  let relocated: { source: string; dest: string }[] = [];
  if (destRoot && !options.dryRun) {
    const outcome = await relocateAll(scanRoot, blurry.map((r) => r.file), destRoot, { move });
    relocated = outcome.relocated;
    errors.push(...outcome.errors);
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
      aperture: contextByFile.get(normalizePath(r.file))?.aperture ?? null,
      pixelSource: r.pixelSource,
      focusMap: reportFocusMap(r, contextByFile.get(normalizePath(r.file))?.orientation ?? 1),
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
    summary: { total: files.length + skipped.length, sharp: sharp.length, blurry: blurry.length, rescued: rescued.length, failed: errors.length },
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

interface FrameContext {
  aperture?: number;
  /** EXIF orientation, 1–8; 1 when unknown. */
  orientation: number;
}

/**
 * Batch-read aperture and orientation for a set of files. Best-effort: any
 * failure (exiftool missing, unreadable files) yields an empty map rather than
 * aborting the cull — both are report context, not decision inputs.
 */
async function readFrameContext(io: ReturnType<typeof makeIo>, files: string[]): Promise<Map<string, FrameContext>> {
  const map = new Map<string, FrameContext>();
  try {
    // 'Orientation#' asks exiftool for the numeric value (1–8) instead of its description.
    const records = await readMetadata(files, { tags: ['FNumber', 'Orientation#'] });
    for (const rec of records) {
      const raw = rec.FNumber;
      const f = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''));
      const o = Number(rec.Orientation);
      map.set(normalizePath(rec.SourceFile), {
        aperture: Number.isFinite(f) ? f : undefined,
        orientation: Number.isInteger(o) && o >= 1 && o <= 8 ? o : 1,
      });
    }
  } catch (err) {
    logVerbose(io, `Aperture and orientation unavailable (exiftool): ${err instanceof Error ? err.message : String(err)}`);
  }
  return map;
}
