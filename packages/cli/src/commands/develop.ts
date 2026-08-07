/**
 * shoots develop — personal develop-setting prediction (the local "Lightroom AI"
 * editor, limited to the global look).
 *
 * Two levels, on purpose. The everyday pair wraps the steps with conventional
 * paths under `~/.shoots/develop`, because nobody should have to remember where
 * last week's dataset went:
 *   init     export + train, from an edited catalog → a reusable style profile.
 *   edit     export + predict, over one shoot → sidecars next to the photographs.
 *   refine   the whole loop after you develop a shoot: feedback + learn +
 *            calibrate, in the only order that works. Reach for this one.
 *   status   what this machine holds.   clean  drop the per-shoot working files.
 *
 * …the three steps `refine` wraps, when you want one of them on its own:
 *   feedback how much of that prediction survived contact with the photographer.
 *   learn    refit on the shoot you just developed, weighted by how much of the
 *            prediction you had to change — the only step that can move the part
 *            that varies photograph to photograph.
 *   calibrate fix what the model is wrong by on average — a constant offset.
 *            Must follow `learn`: a refit writes a new profile and the offsets
 *            go with the old one.
 *
 * …over the individual steps, which stay available whenever the convention is
 * not what you want:
 *   export   build a training dataset from an edited catalog (CLIP + colour
 *            features + crs targets); the only step that touches onnx/exiftool.
 *   train    fit a per-catalog develop profile (multi-output ridge over deltas).
 *   predict  apply a profile to a new set → predicted crs vector / XMP sidecar.
 *   diagnose style-clustering diagnostic (pooled vs per-style skill).
 *
 * The heavy feature extraction lives in `export` (reusing the same seams as
 * `shoots embeddings`); train/predict/diagnose are pure maths over the exported
 * dataset — formerly the standalone `tools/develop`, now folded into the CLI.
 */
import path from 'node:path';
import { Option, type Command } from 'commander';
import { defaultModelConcurrency } from '@shoots/core';
import { logError, logWarn } from '../io.js';
import { BASELINES, runDevelopExport } from '../develop/export.js';
import { DEFAULT_EDITOR, EDITOR_IDS } from '../develop/adapters/registry.js';
import { runRefreshTargets } from '../develop/commands/refresh.js';
import { runTrain } from '../develop/commands/train.js';
import { runPredict } from '../develop/commands/predict.js';
import { runFeedback } from '../develop/commands/feedback.js';
import { runCalibrate } from '../develop/commands/calibrate.js';
import { runLearn } from '../develop/commands/learn.js';
import { runRefine } from '../develop/commands/refine.js';
import { runDiagnose } from '../develop/commands/diagnose.js';
import { runInit, runEdit } from '../develop/commands/pipeline.js';
import { runClean } from '../develop/commands/clean.js';
import { runStatus } from '../develop/commands/status.js';

export function registerDevelopCommand(program: Command): void {
  const develop = program
    .command('develop')
    .description('Personal develop prediction: init → edit → refine (local "Lightroom AI", global look only)');

  develop
    .command('init')
    .description('Learn your style from an edited catalog (export + train) into ~/.shoots/develop')
    .argument('<path>', 'folder of RAW/edited images carrying your develop settings')
    .option('--out-export <file>', 'training dataset path (default: ~/.shoots/develop/export/export.jsonl)')
    .option('--out-train <file>', 'profile path (default: ~/.shoots/develop/profile/export.json)')
    .option('--name <name>', 'profile name', 'my-style')
    .option('--baseline <mode>', `baseline render: ${BASELINES.join(' | ')}`, 'external')
    .option('--everything', 'export every file, not only those carrying an edit')
    .option('--model <kind>', 'inference backend', 'onnx')
    .option('--concurrency <n>', 'max parallel jobs', String(defaultModelConcurrency()))
    .option('--editor <id>', `which editor's develop settings to read: ${EDITOR_IDS.join(' | ')}`, DEFAULT_EDITOR)
    .option('--lambda <n>', "ridge strength, or 'auto' to pick one per parameter", 'auto')
    .option('--folds <k>', 'cross-validation folds', (v) => parseInt(v, 10), 5)
    .option('--group-by <mode>', 'held-out folds: folder (capture sessions) | none (leakage-prone)', 'folder')
    .option('--gate-threshold <n>', 'floor under the adaptive gate; overrides what --boldness sets', (v) => parseFloat(v))
    .option('--boldness <n>', 'how far predictions may travel, 0..1 (0 = safest averages, 1 = moves the sliders). Skill scores fall as this rises — judge it in your editor', (v) => parseFloat(v), 0)
    .option('--anchor-gain <n>', "multiply every anchored slider's fitted correction (1 = as measured); your gain differs per shoot, so this is the intensity you want by default", (v) => parseFloat(v), 1)
    .option('--embedding-dim <k>', 'CLIP components to keep (0 drops it)', (v) => parseInt(v, 10))
    .option('--all', 'report every parameter, not just the image-dependent ones')
    .option('--review', 'open a local page to set the anchored corrections by eye before writing the profile')
    .option('--review-port <n>', 'port for --review', (v) => parseInt(v, 10))
    .option('--review-timeout <min>', 'minutes to wait for --review before keeping the fitted values (0 waits forever)', (v) => parseFloat(v))
    .option('--dry-run', 'print the steps and the paths, write nothing')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runInit);

  develop
    .command('edit')
    .description('Develop a shoot with your profile (export + predict) — sidecars land next to the photographs')
    .argument('<path>', 'folder of the shoot to develop')
    .option('--profile <file>', 'profile to apply (default: the one `develop init` wrote)')
    .option('--treatment <t>', 'which branch to apply: auto | color | bw', 'auto')
    .option('--camera-profile <name>', "base rendering to assume and write out, overriding the catalog's own")
    .option('--baseline <mode>', `baseline render: ${BASELINES.join(' | ')}`, 'external')
    .option('--model <kind>', 'inference backend', 'onnx')
    .option('--concurrency <n>', 'max parallel jobs', String(defaultModelConcurrency()))
    .option('--editor <id>', `which editor's format to read/write: ${EDITOR_IDS.join(' | ')}`, DEFAULT_EDITOR)
    .option('--force', 'overwrite sidecars that already carry a real edit')
    .option('--no-apply-marks', 'leave pending cull/rate marks in the store instead of writing them into the sidecars')
    .option('--dry-run', 'print the steps and the paths, write nothing')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runEdit);

  develop
    .command('status')
    .description('What this machine holds: the dataset, the profile and the cached shoots')
    .option('--json', 'machine-readable JSON output on stdout')
    .action(runStatus);

  develop
    .command('clean')
    .description('Remove the per-shoot working files under ~/.shoots/develop (the profile survives)')
    .option('--all', 'also remove the training dataset and the fitted profile')
    .option('--dry-run', 'list what would be removed, remove nothing')
    .option('--json', 'machine-readable JSON output on stdout')
    .action(runClean);

  develop
    .command('export')
    .description('Export a develop-prediction training dataset (CLIP + colour features + crs targets)')
    .argument('<path>', 'folder (or single file) of RAW/edited images carrying develop settings')
    .option('--model <kind>', 'inference backend (default: onnx)', 'onnx')
    .option('--concurrency <n>', 'max parallel jobs', String(defaultModelConcurrency()))
    .option('--no-cache', 're-embed every frame instead of reusing what a previous run worked out')
    .requiredOption('--out <file>', 'write the JSONL dataset to this path (one record per line + a trailing meta line)')
    .option('--baseline <mode>', `baseline render strategy: ${BASELINES.join(' | ')}`, 'embedded-preview')
    .option('--editor <id>', `which editor's develop settings to read: ${EDITOR_IDS.join(' | ')}`, DEFAULT_EDITOR)
    .option('--edited-only', 'only run the expensive embedding/render on files that carry develop settings (for training-set builds)')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runDevelopExport);

  develop
    .command('refresh-targets')
    .description('Re-read the develop targets of an existing dataset (keeps the embeddings — minutes, not hours)')
    .requiredOption('--data <file>', 'dataset from `shoots develop export`')
    .requiredOption('--out <file>', 'write the refreshed JSONL dataset here')
    .option('--editor <id>', `which editor's develop settings to read: ${EDITOR_IDS.join(' | ')}`, DEFAULT_EDITOR)
    .option('--drop-unedited', 'drop records that carry no real edit instead of keeping them for session context')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runRefreshTargets);

  develop
    .command('train')
    .description('Fit and export the per-catalog develop profile')
    .requiredOption('--data <file>', 'dataset from `shoots develop export`')
    .requiredOption('--name <name>', 'profile name')
    .requiredOption('--out <file>', 'output profile JSON path')
    .option('--lambda <n>', "ridge strength, or 'auto' to pick by cross-validation", 'auto')
    .option('--folds <k>', 'cross-validation folds', (v) => parseInt(v, 10), 5)
    .option('--group-by <mode>', 'held-out folds: folder (whole capture sessions) | none (random, leakage-prone)', 'folder')
    .option('--gate-threshold <n>', 'floor under the adaptive gate; overrides what --boldness sets', (v) => parseFloat(v))
    .option('--boldness <n>', 'how far predictions may travel, 0..1 (0 = safest averages, 1 = moves the sliders). Skill scores fall as this rises — judge it in your editor', (v) => parseFloat(v), 0)
    .option('--anchor-gain <n>', "multiply every anchored slider's fitted correction (1 = as measured); your gain differs per shoot, so this is the intensity you want by default", (v) => parseFloat(v), 1)
    .option('--embedding-dim <k>', 'CLIP components to keep (0 drops it, high values keep it raw)', (v) => parseInt(v, 10))
    .option('--all', 'report every parameter, not just the image-dependent ones')
    .option('--review', 'open a local page to set the anchored corrections by eye before writing the profile')
    .option('--review-port <n>', 'port for --review', (v) => parseInt(v, 10))
    .option('--review-timeout <min>', 'minutes to wait for --review before keeping the fitted values (0 waits forever)', (v) => parseFloat(v))
    .action((opts) => runTrain({
      data: opts.data, name: opts.name, out: opts.out, lambda: opts.lambda, folds: opts.folds,
      groupBy: opts.groupBy, gateThreshold: opts.gateThreshold, boldness: opts.boldness, anchorGain: opts.anchorGain,
      embeddingDim: opts.embeddingDim, all: opts.all,
      review: opts.review, reviewPort: opts.reviewPort, reviewTimeout: opts.reviewTimeout,
    }));

  develop
    .command('predict')
    .description('Apply a develop profile to a new develop-export dataset')
    .requiredOption('--data <file>', 'dataset from `shoots develop export` (the new set)')
    .requiredOption('--profile <file>', 'develop profile JSON from `shoots develop train`')
    .option('--treatment <t>', 'which branch to apply: auto | color | bw', 'auto')
    .option('--out <file>', 'write predictions JSON here (default: stdout)')
    .option('--editor <id>', `which editor's format to write predictions in: ${EDITOR_IDS.join(' | ')}`, DEFAULT_EDITOR)
    .option('--camera-profile <name>', "base rendering to assume and write out, overriding the catalog's own")
    .option('--sidecars <dir>', 'also write an editor-readable sidecar per image into this dir')
    // `--xmp` named the ACR adapter's file extension, which stopped being true
    // the moment a second adapter wrote `.rrdata`. Kept as an alias rather than
    // removed: it is in people's scripts, and a flag that vanishes costs more
    // than one that warns. `--xmp` is hidden from help so it stops spreading.
    .addOption(new Option('--xmp <dir>', 'deprecated alias for --sidecars').hideHelp())
    .action((opts) => {
      if (opts.xmp && opts.sidecars && path.resolve(opts.xmp) !== path.resolve(opts.sidecars)) {
        logError('--xmp and --sidecars name different directories; --xmp is the deprecated alias, pass only --sidecars');
        process.exitCode = 2;
        return;
      }
      if (opts.xmp) logWarn('--xmp is deprecated and will be removed; use --sidecars (it is no longer always XMP)');
      return runPredict({
        data: opts.data, profile: opts.profile, treatment: opts.treatment,
        editor: opts.editor, cameraProfile: opts.cameraProfile, out: opts.out,
        sidecars: opts.sidecars ?? opts.xmp,
      });
    });

  develop
    .command('feedback')
    .description('Compare a prediction against what you actually kept — the real-world quality metric')
    .requiredOption('--predictions <file>', 'predictions JSON from `shoots develop predict --out`')
    .option('--editor <id>', `which editor's develop settings to read: ${EDITOR_IDS.join(' | ')}`, DEFAULT_EDITOR)
    .option('--out <file>', "write this run's (predicted, corrected) pairs here as JSONL")
    .option('--journal <file>', 'journal to accumulate into (default: ~/.shoots/develop/feedback.jsonl)')
    .option('--no-journal', 'measure this run without recording it')
    .option('--min-moved <n>', 'comparisons a parameter needs to be listed', (v) => parseInt(v, 10))
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runFeedback);

  develop
    .command('refine')
    .description('Close the loop on a developed shoot: feedback + learn + calibrate, in the only order that works')
    .argument('<path>', 'the shoot you ran `develop edit` on and have since developed')
    .option('--shoot-dir <dir>', "the shoot's working directory, if not the conventional one")
    .option('--data <file>', 'training dataset to fold into (default: ~/.shoots/develop/export/export.jsonl)')
    .option('--profile <file>', 'profile to refit and calibrate (default: ~/.shoots/develop/profile/export.json)')
    .option('--journal <file>', 'feedback journal (default: ~/.shoots/develop/feedback.jsonl)')
    .option('--editor <id>', `which editor's develop settings to read: ${EDITOR_IDS.join(' | ')}`, DEFAULT_EDITOR)
    .option('--measure-only', 'stop after feedback: record what you kept, change nothing')
    .option('--name <name>', 'profile name', 'my-style')
    .option('--min-weight <n>', 'floor for a frame you accepted wholesale', (v) => parseFloat(v))
    .option('--max-weight <n>', 'ceiling for a frame you overhauled', (v) => parseFloat(v))
    .option('--shrink <n>', 'fraction of each measured correction to apply', (v) => parseFloat(v))
    .option('--min-shoots <n>', 'shoots a parameter needs before it is offset', (v) => parseInt(v, 10))
    .option('--lambda <n>', "ridge strength, or 'auto' to pick one per parameter", 'auto')
    .option('--folds <k>', 'cross-validation folds', (v) => parseInt(v, 10), 5)
    .option('--group-by <mode>', 'held-out folds: folder (capture sessions) | none (leakage-prone)', 'folder')
    .option('--gate-threshold <n>', 'floor under the adaptive gate; overrides what --boldness sets', (v) => parseFloat(v))
    .option('--boldness <n>', 'how far predictions may travel, 0..1 (0 = safest averages, 1 = moves the sliders). Skill scores fall as this rises — judge it in your editor', (v) => parseFloat(v), 0)
    .option('--anchor-gain <n>', "multiply every anchored slider's fitted correction (1 = as measured); your gain differs per shoot, so this is the intensity you want by default", (v) => parseFloat(v), 1)
    .option('--embedding-dim <k>', 'CLIP components to keep (0 drops it)', (v) => parseInt(v, 10))
    .option('--dry-run', 'print the steps and the paths, write nothing')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runRefine);

  develop
    .command('learn')
    .description('Fold a shoot you have developed back into training, weighted by how much you changed')
    .argument('<path>', 'the shoot folder you ran `develop edit` on and have since developed')
    .option('--data <file>', 'training dataset to fold into (default: ~/.shoots/develop/export/export.jsonl)')
    .option('--out <file>', 'profile to refit (default: ~/.shoots/develop/profile/export.json)')
    .option('--shoot-dir <dir>', "the shoot's working directory, if not the conventional one")
    .option('--editor <id>', `which editor's develop settings to read: ${EDITOR_IDS.join(' | ')}`, DEFAULT_EDITOR)
    .option('--name <name>', 'profile name', 'my-style')
    .option('--min-weight <n>', 'floor for a frame you accepted wholesale', (v) => parseFloat(v))
    .option('--max-weight <n>', 'ceiling for a frame you overhauled', (v) => parseFloat(v))
    .option('--no-train', 'update the dataset but stop before refitting')
    .option('--lambda <n>', "ridge strength, or 'auto' to pick one per parameter", 'auto')
    .option('--folds <k>', 'cross-validation folds', (v) => parseInt(v, 10), 5)
    .option('--group-by <mode>', 'held-out folds: folder (capture sessions) | none (leakage-prone)', 'folder')
    .option('--gate-threshold <n>', 'floor under the adaptive gate; overrides what --boldness sets', (v) => parseFloat(v))
    .option('--boldness <n>', 'how far predictions may travel, 0..1 (0 = safest averages, 1 = moves the sliders). Skill scores fall as this rises — judge it in your editor', (v) => parseFloat(v), 0)
    .option('--anchor-gain <n>', "multiply every anchored slider's fitted correction (1 = as measured); your gain differs per shoot, so this is the intensity you want by default", (v) => parseFloat(v), 1)
    .option('--embedding-dim <k>', 'CLIP components to keep (0 drops it)', (v) => parseInt(v, 10))
    .option('--all', 'report every parameter, not just the image-dependent ones')
    .option('--dry-run', 'show the weighting and the plan, write nothing')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runLearn);

  develop
    .command('calibrate')
    .description('Fold the feedback journal back into the profile as per-parameter offsets')
    .option('--profile <file>', 'profile to calibrate (default: ~/.shoots/develop/profile/export.json)')
    .option('--journal <file>', 'journal to read (default: ~/.shoots/develop/feedback.jsonl)')
    .option('--shrink <n>', 'fraction of each measured correction to apply', (v) => parseFloat(v))
    .option('--min-shoots <n>', 'shoots a parameter needs before it is offset', (v) => parseInt(v, 10))
    .option("--include-in-sample", "also use observations the model was already fitted on (optimistic — it says so)")
    .option('--imported-only', 'use only observations still carrying the rendering `predict` wrote')
    .option('--reset', 'remove the calibration and leave the model as trained')
    .option('--review', 're-open the calibration screen against this profile — no refit, for when you missed it during train')
    .option('--data <file>', 'dataset the review previews come from (default: the one `develop init` wrote)')
    .option('--review-port <n>', 'port for --review', (v) => parseInt(v, 10))
    .option('--review-timeout <min>', 'minutes to wait for --review (0 waits forever)', (v) => parseFloat(v))
    .option('--dry-run', 'show the decision, write nothing')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runCalibrate);

  develop
    .command('diagnose')
    .description('Style-clustering diagnostic: pooled vs per-style (clustered) prediction skill')
    .requiredOption('--data <file>', 'dataset from `shoots develop export`')
    .option('--folds <k>', 'cross-validation folds', (v) => parseInt(v, 10), 5)
    .option('--max-k <k>', 'max number of style clusters to try', (v) => parseInt(v, 10), 4)
    .action((opts) => runDiagnose({ data: opts.data, folds: opts.folds, maxK: opts.maxK }));
}
