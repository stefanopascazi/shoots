/**
 * shoots rename <path> --pattern <template>
 *
 * Batch-rename already-imported files in place using the same templating
 * engine as `import`. Renames are executed in two phases (source → temp name
 * → final name) so in-set collisions/swaps cannot clobber files. Existing
 * files are never overwritten.
 */
import { rename as fsRename } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { scanFiles, validateTemplate } from '@shoots/core';
import {
  logError,
  logVerbose,
  makeIo,
  markFailure,
  printHuman,
  printJson,
} from '../io.js';
import { buildNamingPlan, collectNamingInfo } from '../naming.js';

interface RenameOptions {
  pattern: string;
  recursive?: boolean;
  dryRun?: boolean;
  json?: boolean;
  verbose?: boolean;
}

export function registerRenameCommand(program: Command): void {
  program
    .command('rename')
    .description('Batch-rename files in a folder using an EXIF-driven filename template')
    .argument('<path>', 'folder (or single file) to rename in place')
    .requiredOption('--pattern <template>', 'filename template, e.g. "{date}_{time}_{camera}_{seq:4}.{ext}"')
    .option('--recursive', 'recurse into subdirectories (files stay in their own directory)', false)
    .option('--dry-run', 'show planned renames without executing them')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runRename);
}

async function runRename(targetPath: string, options: RenameOptions): Promise<void> {
  const io = makeIo(options);
  const templateError = validateTemplate(options.pattern);
  if (templateError) {
    logError(`Invalid --pattern: ${templateError}`);
    process.exitCode = 2;
    return;
  }

  const files = await scanFiles(targetPath, { recursive: options.recursive ?? false });
  if (files.length === 0) {
    printHuman(io, 'No image files found.');
    if (io.json) printJson({ command: 'rename', dryRun: !!options.dryRun, files: [], summary: { total: 0, renamed: 0, unchanged: 0, failed: 0 } });
    return;
  }
  logVerbose(io, `Found ${files.length} files under ${targetPath}`);

  const infos = await collectNamingInfo(io, files);
  // Each file is renamed within its own directory (in-place operation).
  const plan = buildNamingPlan(infos, options.pattern, (info) => path.dirname(info.file.path));
  const changes = plan.filter((p) => !p.unchanged);

  if (options.dryRun) {
    if (io.json) {
      printJson({
        command: 'rename',
        dryRun: true,
        files: plan.map((p) => ({ source: p.source, dest: p.dest, unchanged: p.unchanged })),
      });
    } else {
      for (const entry of changes) {
        printHuman(io, `rename  ${path.basename(entry.source)}  →  ${path.basename(entry.dest)}`);
      }
      printHuman(io, `\n(dry run) ${changes.length} files would be renamed, ${plan.length - changes.length} unchanged`);
    }
    return;
  }

  // Phase 1: move every changing file to a unique temp name in its directory.
  // Phase 2: temp → final. This makes A→B, B→A swaps safe.
  const errors: { source: string; error: string }[] = [];
  const staged: { temp: string; entry: (typeof changes)[number] }[] = [];

  for (const [i, entry] of changes.entries()) {
    const temp = path.join(path.dirname(entry.source), `.shoots-tmp-${process.pid}-${i}`);
    try {
      await fsRename(entry.source, temp);
      staged.push({ temp, entry });
    } catch (err) {
      errors.push({ source: entry.source, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const renamed: { source: string; dest: string }[] = [];
  for (const { temp, entry } of staged) {
    try {
      await fsRename(temp, entry.dest);
      renamed.push({ source: entry.source, dest: entry.dest });
      logVerbose(io, `renamed ${entry.source} → ${entry.dest}`);
    } catch (err) {
      // Roll the file back to its original name rather than leaving temp litter.
      try {
        await fsRename(temp, entry.source);
      } catch {
        errors.push({ source: entry.source, error: `stuck at temp name ${temp}` });
        continue;
      }
      errors.push({ source: entry.source, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (io.json) {
    printJson({
      command: 'rename',
      dryRun: false,
      files: renamed,
      errors,
      summary: {
        total: plan.length,
        renamed: renamed.length,
        unchanged: plan.length - changes.length,
        failed: errors.length,
      },
    });
  } else {
    for (const r of renamed) {
      printHuman(io, `ok    ${path.basename(r.source)}  →  ${path.basename(r.dest)}`);
    }
    printHuman(io, `\n${renamed.length} renamed, ${plan.length - changes.length} unchanged, ${errors.length} failed`);
  }
  for (const e of errors) logError(`${e.source}: ${e.error}`);
  if (errors.length > 0) markFailure();
}
