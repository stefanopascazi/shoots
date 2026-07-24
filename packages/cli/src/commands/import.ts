/**
 * shoots import <source> --dest <path>
 *
 * Copy (or --move) files from a card/source into a destination folder,
 * renaming via an EXIF-driven template, with SHA-256 verification of every
 * copy. Copy is the default; --move deletes the source ONLY after the copy's
 * checksum has been verified.
 */
import { copyFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { JobQueue, scanFiles, sha256File, validateTemplate } from '@shoots/core';
import {
  logError,
  logVerbose,
  makeIo,
  markFailure,
  parsePositiveInt,
  printHuman,
  printJson,
} from '../io.js';
import { buildNamingPlan, collectNamingInfo } from '../naming.js';
import { startProgress } from '../progress.js';
import { ensureExiftoolReady } from '../tools.js';

/** Applied with `--rename` when no explicit `--pattern` is given. */
export const DEFAULT_RENAME_PATTERN = '{camera}{orig}.{ext}';
/** Default behaviour: keep the original file name untouched. */
export const KEEP_ORIGINAL_PATTERN = '{orig}.{ext}';

interface ImportOptions {
  dest: string;
  pattern?: string;
  rename?: boolean;
  move?: boolean;
  dryRun?: boolean;
  json?: boolean;
  verbose?: boolean;
  concurrency: string;
}

interface ImportedFile {
  source: string;
  dest: string;
  checksum: string | null;
  verified: boolean;
  moved: boolean;
  dateSource: 'exif' | 'mtime';
}

export function registerImportCommand(program: Command): void {
  program
    .command('import')
    .description('Copy/move photos from a source (e.g. memory card) into a destination, renamed and checksum-verified')
    .argument('<source>', 'source directory (or single file)')
    .requiredOption('--dest <path>', 'destination directory')
    .option('--rename', `rename files using the default template "${DEFAULT_RENAME_PATTERN}" (default: keep original names)`)
    .option('--pattern <template>', 'rename files using a custom filename template (implies --rename)')
    .option('--move', 'delete each source file after its copy is checksum-verified (default: copy only)')
    .option('--dry-run', 'show planned actions without executing them')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .option('--concurrency <n>', 'max parallel file operations', '4')
    .action(runImport);
}

async function runImport(source: string, options: ImportOptions): Promise<void> {
  const io = makeIo(options);

  // Renaming is opt-in: --pattern (custom) or --rename (default template).
  // Without either, files keep their original names.
  const wantsRename = options.pattern !== undefined || !!options.rename;
  const pattern = options.pattern ?? (options.rename ? DEFAULT_RENAME_PATTERN : KEEP_ORIGINAL_PATTERN);

  if (wantsRename) {
    const templateError = validateTemplate(pattern);
    if (templateError) {
      logError(`Invalid --pattern: ${templateError}`);
      process.exitCode = 2;
      return;
    }
    // Renaming reads EXIF (camera/date) — make sure exiftool is available.
    if (!(await ensureExiftoolReady(io))) return;
  }

  const files = await scanFiles(source);
  if (files.length === 0) {
    printHuman(io, 'No image files found.');
    if (io.json) printJson({ command: 'import', dryRun: !!options.dryRun, files: [], errors: [], summary: { total: 0, succeeded: 0, failed: 0 } });
    return;
  }
  logVerbose(io, `Found ${files.length} files under ${source}`);

  const destRoot = path.resolve(options.dest);
  // Only read EXIF when a template needs it; keeping original names must not
  // depend on exiftool being installed.
  const infos = wantsRename
    ? await collectNamingInfo(io, files)
    : files.map((file) => ({
        file,
        date: file.mtime,
        dateSource: 'mtime' as const,
        camera: null,
        lens: null,
      }));
  const plan = buildNamingPlan(infos, pattern, () => destRoot);

  if (options.dryRun) {
    if (io.json) {
      printJson({
        command: 'import',
        dryRun: true,
        move: !!options.move,
        files: plan.map((p) => ({ source: p.source, dest: p.dest, dateSource: p.dateSource })),
      });
    } else {
      for (const entry of plan) {
        printHuman(io, `${options.move ? 'move' : 'copy'}  ${entry.source}  →  ${entry.dest}`);
      }
      printHuman(io, `\n(dry run) ${plan.length} files would be ${options.move ? 'moved' : 'copied'} to ${destRoot}`);
    }
    return;
  }

  await mkdir(destRoot, { recursive: true });

  const queue = new JobQueue({ concurrency: parsePositiveInt(options.concurrency, 4) });
  const progress = await startProgress(io, plan.length, 'Importing');

  const outcomes = await queue.run(
    plan,
    async (entry): Promise<ImportedFile> => {
      if (existsSync(entry.dest)) {
        // buildNamingPlan avoids this, but a concurrent writer could race us.
        throw new Error(`Destination already exists, refusing to overwrite: ${entry.dest}`);
      }
      await copyFile(entry.source, entry.dest);
      const [srcHash, dstHash] = await Promise.all([sha256File(entry.source), sha256File(entry.dest)]);
      if (srcHash !== dstHash) {
        await unlink(entry.dest); // remove OUR corrupt copy; source is untouched
        throw new Error(`Checksum mismatch after copy: ${entry.source} (source ${srcHash} ≠ copy ${dstHash})`);
      }
      let moved = false;
      if (options.move) {
        await unlink(entry.source);
        moved = true;
      }
      return {
        source: entry.source,
        dest: entry.dest,
        checksum: srcHash,
        verified: true,
        moved,
        dateSource: entry.dateSource,
      };
    },
    progress.onProgress,
    (entry) => path.basename(entry.source),
  );

  progress.stop();

  const succeeded = outcomes.filter((o) => o.ok);
  const failed = outcomes.filter((o) => !o.ok);
  const errors = failed.map((o) => ({ source: o.item.source, error: o.error?.message ?? 'unknown error' }));

  if (io.json) {
    printJson({
      command: 'import',
      dryRun: false,
      move: !!options.move,
      files: succeeded.map((o) => o.value),
      errors,
      summary: { total: outcomes.length, succeeded: succeeded.length, failed: failed.length },
    });
  } else {
    for (const o of succeeded) {
      printHuman(io, `ok    ${o.value!.source}  →  ${o.value!.dest}  [sha256 verified]`);
    }
    printHuman(io, `\n${succeeded.length}/${outcomes.length} files ${options.move ? 'moved' : 'copied'} to ${destRoot}`);
  }
  for (const e of errors) logError(`${e.source}: ${e.error}`);
  if (failed.length > 0) markFailure();
}
