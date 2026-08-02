/**
 * The two-step pipelines: `develop init` and `develop edit`.
 *
 * `export → train` and `export → predict` are always run together and always
 * with the same paths, so typing them out every time is both tedious and a way
 * to get the baseline or the profile path subtly wrong. These wrap them with
 * conventional locations under `~/.shoots/develop` (see core/paths.ts), leaving
 * every underlying flag available for when the convention is not what you want.
 *
 * Both honour `--dry-run`: they print the steps and the paths they would use and
 * touch nothing. `edit` writes into the photographer's own folder, so being able
 * to see what it is about to do before it does it is not a nicety.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import {
  developExportPath,
  developProfilePath,
  developShootDir,
} from '@shoots/core';
import { runDevelopExport, BASELINES, type DevelopExportOptions } from '../export.js';
import { runTrain } from './train.js';
import { runPredict } from './predict.js';
import { DEFAULT_EDITOR, EDITOR_IDS, resolveAdapter } from '../adapters/registry.js';
import { logError, logWarn, makeIo, printHuman, printJson } from '../../io.js';
import { ensureExiftoolReady } from '../../tools.js';
import type { DevelopProfile } from '../types.js';

/** Flags common to both pipelines, mirroring the underlying commands. */
interface CommonArgs {
  baseline: string;
  model: string;
  concurrency: string;
  editor?: string;
  dryRun?: boolean;
  json?: boolean;
  verbose?: boolean;
}

export interface InitArgs extends CommonArgs {
  /** Where the training dataset goes (default: ~/.shoots/develop/export/export.jsonl). */
  outExport?: string;
  /** Where the fitted profile goes (default: ~/.shoots/develop/profile/export.json). */
  outTrain?: string;
  name: string;
  lambda: string;
  folds: number;
  groupBy?: string;
  gateThreshold?: number;
  embeddingDim?: number;
  all?: boolean;
  /** Export every file, not only those carrying an edit. */
  everything?: boolean;
}

export interface EditArgs extends CommonArgs {
  /** Profile to apply (default: the one `develop init` wrote). */
  profile?: string;
  treatment: string;
  cameraProfile?: string;
  /** Overwrite sidecars that already carry a real edit. */
  force?: boolean;
}

function validate(args: CommonArgs): boolean {
  if (!BASELINES.includes(args.baseline as (typeof BASELINES)[number])) {
    logError(`unknown --baseline '${args.baseline}' (available: ${BASELINES.join(', ')})`);
    process.exitCode = 2;
    return false;
  }
  const editor = args.editor ?? DEFAULT_EDITOR;
  if (!EDITOR_IDS.includes(editor)) {
    logError(`unknown --editor '${editor}' (available: ${EDITOR_IDS.join(', ')})`);
    process.exitCode = 2;
    return false;
  }
  return true;
}

const exportOptions = (args: CommonArgs, out: string, editedOnly: boolean): DevelopExportOptions => ({
  model: args.model,
  concurrency: args.concurrency,
  out,
  baseline: args.baseline,
  editor: args.editor,
  editedOnly,
  json: false, // the pipeline owns the JSON envelope
  verbose: args.verbose,
});

/** Did the step just run fail? The underlying commands report through the exit code. */
const failed = (): boolean => (process.exitCode ?? 0) !== 0;

// ── develop init ─────────────────────────────────────────────────────────────

export async function runInit(targetPath: string, args: InitArgs): Promise<void> {
  const io = makeIo(args);
  if (!validate(args)) return;

  const datasetPath = path.resolve(args.outExport ?? developExportPath());
  const profilePath = path.resolve(args.outTrain ?? developProfilePath());

  if (args.dryRun) {
    const plan = {
      command: 'develop-init' as const,
      dryRun: true,
      steps: [
        { step: 'export', path: targetPath, out: datasetPath, baseline: args.baseline, editedOnly: !args.everything },
        { step: 'train', data: datasetPath, name: args.name, out: profilePath },
      ],
    };
    if (io.json) printJson(plan);
    else {
      printHuman(io, 'Dry run — nothing written.\n');
      printHuman(io, `  1. export ${targetPath}`);
      printHuman(io, `       baseline ${args.baseline}${args.everything ? '' : ', edited files only'} → ${datasetPath}`);
      printHuman(io, `  2. train  → ${profilePath}  (profile '${args.name}')`);
    }
    return;
  }

  await mkdir(path.dirname(datasetPath), { recursive: true });
  await mkdir(path.dirname(profilePath), { recursive: true });

  printHuman(io, `[1/2] Building the training dataset → ${datasetPath}`);
  await runDevelopExport(targetPath, exportOptions(args, datasetPath, !args.everything));
  if (failed()) {
    logError('export failed — stopping before train (the dataset would be incomplete)');
    return;
  }

  printHuman(io, `\n[2/2] Fitting the profile → ${profilePath}`);
  await runTrain({
    data: datasetPath,
    name: args.name,
    out: profilePath,
    lambda: args.lambda,
    folds: args.folds,
    groupBy: args.groupBy,
    gateThreshold: args.gateThreshold,
    embeddingDim: args.embeddingDim,
    all: args.all,
    json: args.json,
    verbose: args.verbose,
  });
  if (failed()) return;

  if (io.json) printJson({ command: 'develop-init', dataset: datasetPath, profile: profilePath });
  else printHuman(io, `\nReady. \`shoots develop edit <shoot>\` will use ${profilePath}.`);
}

// ── develop edit ─────────────────────────────────────────────────────────────

/**
 * Sidecars in the target folder that already carry a real edit.
 *
 * `edit` writes its predictions next to the photographs, which is the point —
 * Lightroom reads them there. It also means an existing edit is overwritten, and
 * an accidental run on an already-developed shoot would be unrecoverable. So it
 * counts them first and stops, rather than asking forgiveness afterwards.
 */
async function editedSidecars(targetPath: string, editorId: string, io: ReturnType<typeof makeIo>): Promise<number> {
  const adapter = resolveAdapter(editorId);
  const { scanFiles } = await import('@shoots/core');
  const files = await scanFiles(targetPath);
  if (files.length === 0) return 0;
  const edits = await adapter.readEdits(files.map((f) => f.path), io);
  let n = 0;
  for (const [, edit] of edits) if (edit.edited) n++;
  return n;
}

export async function runEdit(targetPath: string, args: EditArgs): Promise<void> {
  const io = makeIo(args);
  if (!validate(args)) return;

  const folder = path.basename(path.resolve(targetPath));
  const workDir = developShootDir(folder);
  const datasetPath = path.join(workDir, 'export.jsonl');
  const predictionPath = path.join(workDir, 'prediction.json');
  const profilePath = path.resolve(args.profile ?? developProfilePath());

  if (!existsSync(profilePath)) {
    logError(`no profile at ${profilePath} — run \`shoots develop init <catalog>\` first, or pass --profile`);
    process.exitCode = 2;
    return;
  }

  if (args.dryRun) {
    const plan = {
      command: 'develop-edit' as const,
      dryRun: true,
      shoot: folder,
      steps: [
        { step: 'export', path: targetPath, out: datasetPath, baseline: args.baseline },
        { step: 'predict', profile: profilePath, xmp: path.resolve(targetPath), out: predictionPath },
      ],
    };
    if (io.json) printJson(plan);
    else {
      printHuman(io, 'Dry run — nothing written.\n');
      printHuman(io, `  1. export ${targetPath}`);
      printHuman(io, `       baseline ${args.baseline} → ${datasetPath}`);
      printHuman(io, `  2. predict with ${profilePath}`);
      printHuman(io, `       sidecars → ${path.resolve(targetPath)}  (next to the photographs)`);
      printHuman(io, `       record   → ${predictionPath}  (for \`develop feedback\`)`);
    }
    return;
  }

  // Guard before anything is written: an existing edit in the target folder is
  // about to be replaced by a prediction.
  if (!args.force) {
    if (!(await ensureExiftoolReady(io))) return;
    const alreadyEdited = await editedSidecars(targetPath, args.editor ?? DEFAULT_EDITOR, io);
    if (alreadyEdited > 0) {
      logError(
        `${alreadyEdited} file(s) in ${targetPath} already carry a real edit, and writing sidecars here would ` +
          `replace them. Re-run with --force if that is what you want, or --dry-run to see the plan.`,
      );
      process.exitCode = 2;
      return;
    }
  }

  await mkdir(workDir, { recursive: true });

  printHuman(io, `[1/2] Reading the shoot → ${datasetPath}`);
  await runDevelopExport(targetPath, exportOptions(args, datasetPath, false));
  if (failed()) {
    logError('export failed — stopping before predict');
    return;
  }

  printHuman(io, `\n[2/2] Predicting with ${path.basename(profilePath)}`);
  await runPredict({
    data: datasetPath,
    profile: profilePath,
    treatment: args.treatment,
    editor: args.editor,
    cameraProfile: args.cameraProfile,
    xmp: path.resolve(targetPath),
    out: predictionPath,
  });
  if (failed()) return;

  let profileName = path.basename(profilePath);
  try {
    profileName = (JSON.parse(await readFile(profilePath, 'utf8')) as DevelopProfile).name;
  } catch {
    logWarn('could not read the profile name back for the summary');
  }

  if (io.json) {
    printJson({ command: 'develop-edit', shoot: folder, profile: profileName, dataset: datasetPath, predictions: predictionPath });
    return;
  }
  printHuman(io, `\nSidecars written next to the photographs, from profile '${profileName}'.`);
  printHuman(io, `Once you have developed them, \`shoots develop feedback --predictions ${predictionPath}\``);
  printHuman(io, 'reports how much of the prediction you kept.');
}
