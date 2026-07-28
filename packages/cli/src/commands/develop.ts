/**
 * shoots develop — personal develop-setting prediction (the local "Lightroom AI"
 * editor, limited to the global look).
 *
 * A single command group over the whole pipeline:
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
import type { Command } from 'commander';
import { BASELINES, runDevelopExport } from '../develop/export.js';
import { DEFAULT_EDITOR, EDITOR_IDS } from '../develop/adapters/registry.js';
import { runRefreshTargets } from '../develop/commands/refresh.js';
import { runTrain } from '../develop/commands/train.js';
import { runPredict } from '../develop/commands/predict.js';
import { runDiagnose } from '../develop/commands/diagnose.js';

export function registerDevelopCommand(program: Command): void {
  const develop = program
    .command('develop')
    .description('Personal develop prediction: export → train → predict (local "Lightroom AI", global look only)');

  develop
    .command('export')
    .description('Export a develop-prediction training dataset (CLIP + colour features + crs targets)')
    .argument('<path>', 'folder (or single file) of RAW/edited images carrying develop settings')
    .option('--model <kind>', 'inference backend (default: onnx)', 'onnx')
    .option('--concurrency <n>', 'max parallel jobs', '4')
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
    .option('--keep-unedited', 'keep records that no longer carry a real edit (default: drop, as export does)')
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
    .option('--gate-threshold <n>', 'skill at or below which a param falls back to your constant (0 disables)', (v) => parseFloat(v), 0.02)
    .option('--all', 'report every parameter, not just the image-dependent ones')
    .action((opts) => runTrain({
      data: opts.data, name: opts.name, out: opts.out, lambda: opts.lambda, folds: opts.folds,
      groupBy: opts.groupBy, gateThreshold: opts.gateThreshold, all: opts.all,
    }));

  develop
    .command('predict')
    .description('Apply a develop profile to a new develop-export dataset')
    .requiredOption('--data <file>', 'dataset from `shoots develop export` (the new set)')
    .requiredOption('--profile <file>', 'develop profile JSON from `shoots develop train`')
    .option('--treatment <t>', 'which branch to apply: auto | color | bw', 'auto')
    .option('--out <file>', 'write predictions JSON here (default: stdout)')
    .option('--editor <id>', `which editor's format to write predictions in: ${EDITOR_IDS.join(' | ')}`, DEFAULT_EDITOR)
    .option('--xmp <dir>', 'also write an editor-readable sidecar per image into this dir')
    .action((opts) => runPredict({
      data: opts.data, profile: opts.profile, treatment: opts.treatment,
      editor: opts.editor, out: opts.out, xmp: opts.xmp,
    }));

  develop
    .command('diagnose')
    .description('Style-clustering diagnostic: pooled vs per-style (clustered) prediction skill')
    .requiredOption('--data <file>', 'dataset from `shoots develop export`')
    .option('--folds <k>', 'cross-validation folds', (v) => parseInt(v, 10), 5)
    .option('--max-k <k>', 'max number of style clusters to try', (v) => parseInt(v, 10), 4)
    .action((opts) => runDiagnose({ data: opts.data, folds: opts.folds, maxK: opts.maxK }));
}
