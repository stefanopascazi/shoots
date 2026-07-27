#!/usr/bin/env node
/**
 * develop — personal develop-setting prediction for Shoots.
 *
 * train → predict. Consumes `shoots develop-export` datasets and emits a
 * per-catalog develop profile (multi-output ridge over develop-setting deltas).
 * Separate from the Shoots monorepo: its own deps, its own build; it never loads
 * onnxruntime — the heavy feature extraction lives in `shoots develop-export`.
 */
import { Command } from 'commander';
import { runTrain } from './commands/train.js';
import { runPredict } from './commands/predict.js';
import { runDiagnose } from './commands/diagnose.js';

const program = new Command();
program
  .name('develop')
  .description('Personal develop prediction: develop-export dataset → multi-output ridge → per-catalog profile')
  .version('0.1.0');

program
  .command('train')
  .description('Fit and export the per-catalog develop profile')
  .requiredOption('--data <file>', 'dataset.json from `shoots develop-export`')
  .requiredOption('--name <name>', 'profile name')
  .requiredOption('--out <file>', 'output profile JSON path')
  .option('--lambda <n>', "ridge strength, or 'auto' to pick by cross-validation", 'auto')
  .option('--folds <k>', 'cross-validation folds', (v) => parseInt(v, 10), 5)
  .action((opts) => runTrain({ data: opts.data, name: opts.name, out: opts.out, lambda: opts.lambda, folds: opts.folds }));

program
  .command('predict')
  .description('Apply a develop profile to a new develop-export dataset')
  .requiredOption('--data <file>', 'dataset.json from `shoots develop-export` (the new set)')
  .requiredOption('--profile <file>', 'develop profile JSON from `develop train`')
  .option('--treatment <t>', 'which branch to apply: auto | color | bw', 'auto')
  .option('--out <file>', 'write predictions JSON here (default: stdout)')
  .option('--xmp <dir>', 'also write a Lightroom-readable .xmp sidecar per image into this dir')
  .action((opts) => runPredict({ data: opts.data, profile: opts.profile, treatment: opts.treatment, out: opts.out, xmp: opts.xmp }));

program
  .command('diagnose')
  .description('Style-clustering diagnostic: pooled vs per-style (clustered) prediction skill')
  .requiredOption('--data <file>', 'dataset from `shoots develop-export`')
  .option('--folds <k>', 'cross-validation folds', (v) => parseInt(v, 10), 5)
  .option('--max-k <k>', 'max number of style clusters to try', (v) => parseInt(v, 10), 4)
  .action((opts) => runDiagnose({ data: opts.data, folds: opts.folds, maxK: opts.maxK }));

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
