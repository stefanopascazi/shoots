/**
 * shoots triage — inspect, apply and clean the marks `cull` and `rate` leave.
 *
 * `develop edit` applies pending marks on its way past, which covers the usual
 * shoot. This command exists for the two cases it does not: seeing what is
 * waiting before committing to a develop run, and getting the marks into
 * sidecars when there is no develop profile in play at all — culling and rating
 * a shoot you intend to edit by hand is a complete workflow, and marks with no
 * exit would make it a dead end.
 */
import path from 'node:path';
import type { Command } from 'commander';
import { scanFiles } from '@shoots/core';
import { DEFAULT_EDITOR, EDITOR_IDS, resolveAdapter } from '../develop/adapters/registry.js';
import { logError, logVerbose, makeIo, markFailure, oneLine, printHuman, printJson } from '../io.js';
import { startPhase } from '../progress.js';
import { applyMarks } from '../triage/apply.js';
import { resolveLabelSet, LabelSetError } from '../triage/labelSets.js';
import { isPending } from '../triage/schema.js';
import { purgeMarks, readAllMarks, readMarks } from '../triage/store.js';

interface ListOptions {
  json?: boolean;
  verbose?: boolean;
}

interface ApplyOptions extends ListOptions {
  editor?: string;
  redo?: boolean;
  dryRun?: boolean;
}

interface CleanOptions extends ListOptions {
  orphans?: boolean;
  dryRun?: boolean;
}

export function registerTriageCommand(program: Command): void {
  const triage = program
    .command('triage')
    .description('The marks `cull` and `rate` recorded, before they reach a sidecar');

  triage
    .command('list', { isDefault: true })
    .description('What is waiting to be written, for a shoot or for the whole machine')
    .argument('[path]', 'folder to report on (default: every shoot with marks)')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runList);

  triage
    .command('apply')
    .description('Write the pending marks into sidecars next to the photographs')
    .argument('<path>', 'folder whose marks should be written out')
    .option('--editor <id>', `whose label vocabulary to write in: ${EDITOR_IDS.join(' | ')}`, DEFAULT_EDITOR)
    .option('--redo', 'also rewrite marks already applied once')
    .option('--dry-run', 'report what would be written, write nothing')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runApply);

  triage
    .command('clean')
    .description('Drop marks already written to a sidecar (and, with --orphans, those whose file is gone)')
    .option('--orphans', 'also drop pending marks whose photograph no longer exists')
    .option('--dry-run', 'count what would be dropped, drop nothing')
    .option('--json', 'machine-readable JSON output on stdout')
    .action(runClean);
}

// ── triage list ──────────────────────────────────────────────────────────────

async function runList(targetPath: string | undefined, options: ListOptions): Promise<void> {
  const io = makeIo(options);

  const shoots: { store: string; pending: number; applied: number }[] = [];
  let pendingTotal = 0;
  let appliedTotal = 0;

  if (targetPath) {
    const files = await scanFiles(targetPath);
    const marks = await readMarks(files.map((f) => f.path));
    for (const record of marks.values()) (isPending(record) ? pendingTotal++ : appliedTotal++);
    shoots.push({ store: path.resolve(targetPath), pending: pendingTotal, applied: appliedTotal });
  } else {
    for (const [store, records] of await readAllMarks()) {
      let pending = 0;
      let applied = 0;
      for (const record of records.values()) (isPending(record) ? pending++ : applied++);
      shoots.push({ store, pending, applied });
      pendingTotal += pending;
      appliedTotal += applied;
    }
  }

  if (io.json) {
    printJson({ command: 'triage-list', shoots, summary: { pending: pendingTotal, applied: appliedTotal } });
    return;
  }
  if (shoots.length === 0 || pendingTotal + appliedTotal === 0) {
    printHuman(io, 'No triage marks. `shoots cull --mark` and `shoots rate --mark` create them.');
    return;
  }
  for (const s of shoots) {
    printHuman(io, `${String(s.pending).padStart(6)} pending  ${String(s.applied).padStart(6)} applied   ${s.store}`);
  }
  printHuman(io, `\n${pendingTotal} pending, ${appliedTotal} applied`);
  if (pendingTotal > 0) {
    printHuman(io, '`shoots develop edit <shoot>` writes them alongside a prediction, `shoots triage apply <shoot>` on their own.');
  }
}

// ── triage apply ─────────────────────────────────────────────────────────────

async function runApply(targetPath: string, options: ApplyOptions): Promise<void> {
  const io = makeIo(options);

  const editorId = options.editor ?? DEFAULT_EDITOR;
  if (!EDITOR_IDS.includes(editorId)) {
    logError(`unknown --editor '${editorId}' (available: ${EDITOR_IDS.join(', ')})`);
    process.exitCode = 2;
    return;
  }
  const adapter = resolveAdapter(editorId);
  if (!adapter.writeMarks) {
    logError(`the '${editorId}' adapter cannot write annotations (read-only source)`);
    process.exitCode = 2;
    return;
  }

  // Fail on a malformed label override before touching anything: writing half a
  // shoot and then discovering the vocabulary is wrong is the bad outcome.
  try {
    const labels = await resolveLabelSet(editorId);
    logVerbose(io, `Label set: ${Object.entries(labels).map(([k, v]) => `${k}→${v}`).join(', ')}`);
  } catch (err) {
    logError(err instanceof LabelSetError ? err.message : String(err));
    process.exitCode = 2;
    return;
  }

  const scanPhase = startPhase(io, 'Scanning');
  const files = await scanFiles(targetPath, { onProgress: (found) => scanPhase.update(`${found} files`) });
  scanPhase.done(`${files.length} files`);
  if (files.length === 0) {
    printHuman(io, 'No image files found.');
    return;
  }

  // Whatever this editor needs in order to be written to — exiftool for ACR,
  // nothing at all for an adapter whose sidecar is a JSON file.
  if (!options.dryRun && adapter.ensureWritable && !(await adapter.ensureWritable(io))) return;

  // Sidecars land next to the photographs — the same convention `develop edit`
  // uses, and the only place Lightroom looks for a RAW's sidecar.
  const sidecarFor = (file: string): string => adapter.sidecarPathFor!(file, path.dirname(path.resolve(file)));

  const result = await applyMarks(adapter, files.map((f) => f.path), sidecarFor, {
    includeApplied: options.redo,
    dryRun: options.dryRun,
  });

  if (io.json) {
    printJson({
      command: 'triage-apply',
      editor: editorId,
      dryRun: !!options.dryRun,
      applied: result.applied,
      skipped: result.skipped,
      errors: result.errors,
      summary: { applied: result.applied.length, skipped: result.skipped.length, failed: result.errors.length },
    });
  } else {
    for (const a of result.applied) {
      // Adapters name what they wrote in their own terms — `XMP:Rating` for ACR,
      // a bare `rating` for RapidRAW. The group prefix is noise to the reader.
      const tags = Object.entries(a.tags).map(
        ([k, v]) => `${k.replace(/^[A-Za-z]+:/, '')}=${Array.isArray(v) ? v.join('/') : String(v)}`,
      );
      printHuman(io, `${path.basename(a.file)}  →  ${path.basename(a.sidecar)}  ${tags.join(' ')}`);
    }
    printHuman(
      io,
      options.dryRun
        ? `\n(dry run) ${result.applied.length} sidecar(s) would be written in ${editorId} vocabulary`
        : `\n${result.applied.length} sidecar(s) written in ${editorId} vocabulary; the marks are now applied`,
    );
    if (result.applied.length === 0 && !options.redo) {
      printHuman(io, 'Nothing pending — `--redo` rewrites marks that were already applied.');
    }
  }
  for (const e of result.errors) logError(`${e.file}: ${oneLine(e.error)}`);
  if (result.errors.length > 0) markFailure();
}

// ── triage clean ─────────────────────────────────────────────────────────────

async function runClean(options: CleanOptions): Promise<void> {
  const io = makeIo(options);
  const result = await purgeMarks({ orphans: options.orphans, dryRun: options.dryRun });

  if (io.json) {
    printJson({ command: 'triage-clean', dryRun: !!options.dryRun, ...result });
    return;
  }
  const verb = options.dryRun ? 'would drop' : 'dropped';
  printHuman(io, `${verb} ${result.applied} applied mark(s)${options.orphans ? `, ${result.orphaned} orphaned` : ''}`);
  if (!options.orphans) printHuman(io, '(pending marks are kept; `--orphans` also drops those whose photograph is gone)');
}
