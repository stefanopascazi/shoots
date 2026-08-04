/**
 * `develop refine <shoot>` — the whole loop after you have developed a shoot.
 *
 * `feedback` then `learn` then `calibrate`, always in that order and always with
 * the same paths. Typing them out is three chances to get the shoot's prediction
 * path wrong and one to run `calibrate` before `learn`, which silently throws the
 * calibration away — `learn` writes a whole new profile.
 *
 * Each step earns its place:
 *
 *  - **feedback** records what you kept into the journal. It is the only step
 *    that captures the (predicted, corrected) pair, and the journal outlives
 *    `clean` while the shoot's working files do not.
 *  - **learn** refits the model with the shoot folded in, weighted by how much
 *    of the prediction you had to change. This is the only step that can move
 *    the part of the prediction that varies photograph to photograph.
 *  - **calibrate** re-measures the constant offsets against the model that just
 *    came out of `learn`, from the shoots it has *not* been fitted on.
 *
 * That last clause is why the order cannot be rearranged and why calibrate often
 * has nothing to say right after a refit: the shoot it just learned from can no
 * longer measure it. That is correct, and the report says so rather than
 * inventing an offset from evidence the model has already seen.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { developFeedbackPath, developProfilePath, developShootDir } from '@shoots/core';
import { runFeedback } from './feedback.js';
import { runLearn } from './learn.js';
import { runCalibrate } from './calibrate.js';
import { DEFAULT_EDITOR, EDITOR_IDS } from '../adapters/registry.js';
import { logError, makeIo, printHuman, printJson } from '../../io.js';

export interface RefineArgs {
  /** The shoot's working directory, when it is not the conventional one. */
  shootDir?: string;
  data?: string;
  profile?: string;
  journal?: string;
  editor?: string;
  name: string;
  lambda: string;
  folds: number;
  groupBy?: string;
  gateThreshold?: number;
  boldness?: number;
  embeddingDim?: number;
  minWeight?: number;
  maxWeight?: number;
  shrink?: number;
  minShoots?: number;
  /** Stop after `feedback`: measure the shoot without changing anything. */
  measureOnly?: boolean;
  dryRun?: boolean;
  json?: boolean;
  verbose?: boolean;
}

const failed = (): boolean => (process.exitCode ?? 0) !== 0;

export async function runRefine(targetPath: string, args: RefineArgs): Promise<void> {
  const io = makeIo(args);
  const editorId = args.editor ?? DEFAULT_EDITOR;
  if (!EDITOR_IDS.includes(editorId)) {
    logError(`unknown --editor '${editorId}' (available: ${EDITOR_IDS.join(', ')})`);
    process.exitCode = 2;
    return;
  }

  const folder = path.basename(path.resolve(targetPath));
  const workDir = args.shootDir ? path.resolve(args.shootDir) : developShootDir(folder);
  const predictionPath = path.join(workDir, 'prediction.json');
  const profilePath = path.resolve(args.profile ?? developProfilePath());
  const journalPath = path.resolve(args.journal ?? developFeedbackPath());

  if (!existsSync(predictionPath)) {
    logError(
      `no prediction record at ${predictionPath} — \`develop refine\` closes the loop on a shoot that ` +
        `\`shoots develop edit ${targetPath}\` opened; run that first, develop the photographs, then come back`,
    );
    process.exitCode = 2;
    return;
  }

  const steps = args.measureOnly
    ? ['feedback']
    : ['feedback', 'learn', 'calibrate'];

  if (args.dryRun) {
    const plan = {
      command: 'develop-refine' as const,
      dryRun: true,
      shoot: folder,
      steps: [
        { step: 'feedback', predictions: predictionPath, journal: journalPath },
        ...(args.measureOnly ? [] : [
          { step: 'learn', shoot: targetPath, profile: profilePath },
          { step: 'calibrate', profile: profilePath, journal: journalPath },
        ]),
      ],
    };
    if (io.json) printJson(plan);
    else {
      printHuman(io, 'Dry run — nothing written.\n');
      printHuman(io, `  1. feedback  ${predictionPath}`);
      printHuman(io, `       → records what you kept in ${journalPath}`);
      if (!args.measureOnly) {
        printHuman(io, `  2. learn     ${targetPath}`);
        printHuman(io, `       → folds it into training, weighted, and refits ${profilePath}`);
        printHuman(io, `  3. calibrate`);
        printHuman(io, '       → re-measures the constant offsets against the refitted model');
        printHuman(io, '\n  Step 2 replaces the profile, so any calibration on it goes with it —');
        printHuman(io, '  which is why step 3 exists and why it cannot come earlier.');
      }
    }
    return;
  }

  printHuman(io, `\n═══ [1/${steps.length}] What you kept ═══`);
  await runFeedback({
    predictions: predictionPath,
    editor: editorId,
    journal: args.journal,
    verbose: args.verbose,
  });
  if (failed()) {
    logError('feedback failed — stopping before anything is changed');
    return;
  }

  if (args.measureOnly) {
    printHuman(io, '\n--measure-only: the journal is updated, the profile untouched.');
    return;
  }

  printHuman(io, `\n═══ [2/3] Learning from it ═══`);
  await runLearn(targetPath, {
    data: args.data,
    out: args.profile,
    shootDir: args.shootDir,
    journal: args.journal,
    editor: editorId,
    name: args.name,
    lambda: args.lambda,
    folds: args.folds,
    groupBy: args.groupBy,
    gateThreshold: args.gateThreshold,
    boldness: args.boldness,
    embeddingDim: args.embeddingDim,
    minWeight: args.minWeight,
    maxWeight: args.maxWeight,
    verbose: args.verbose,
  });
  if (failed()) {
    logError('learn failed — the profile is unchanged, and the journal still holds this shoot');
    return;
  }

  printHuman(io, `\n═══ [3/3] Re-measuring the constants ═══`);
  await runCalibrate({
    profile: args.profile,
    journal: args.journal,
    shrink: args.shrink,
    minShoots: args.minShoots,
    verbose: args.verbose,
  });
  // Nothing to calibrate on is the normal state early in a catalog's life, not a
  // failure of the run: `calibrate` exits 2 to say "I did nothing", which would
  // otherwise turn a successful refine into a failed one.
  if (failed()) {
    process.exitCode = 0;
    printHuman(io, '\nNo constants to re-measure yet — the refit is done and stands on its own.');
  }

  if (io.json) {
    printJson({ command: 'develop-refine', shoot: folder, profile: profilePath, journal: journalPath });
    return;
  }
  printHuman(io, `\nDone. '${folder}' is in the model now; the next \`shoots develop edit\` will show it.`);
}
