#!/usr/bin/env node
/**
 * match — pairwise preference learning for Shoots.
 *
 * import → serve (duels) → train. Consumes `shoots embeddings` datasets and
 * emits a linear-embedding rating profile. Separate from the Shoots monorepo:
 * its own deps, its own build; it never loads onnxruntime.
 */
import { Command } from 'commander';
import { resolve } from 'node:path';
import { runImport } from './commands/import.js';
import { runServe } from './commands/serve.js';
import { runTrain } from './commands/train.js';

const DEFAULT_DB = resolve('match.db');

const program = new Command();
program
  .name('match')
  .description('Pairwise photo-preference learning: duels → Bradley-Terry → linear-embedding profile')
  .version('0.1.0');

program
  .command('import')
  .description('Load a `shoots embeddings --json` dataset into SQLite')
  .requiredOption('--data <file>', 'dataset.json from `shoots embeddings`')
  .option('--images <dir>', 'base folder to resolve image paths for the UI')
  .option('--db <file>', 'SQLite database file', DEFAULT_DB)
  .action((opts) => runImport({ data: opts.data, images: opts.images, db: opts.db }));

program
  .command('serve')
  .description('Launch the local duel UI')
  .option('--db <file>', 'SQLite database file', DEFAULT_DB)
  .option('--port <n>', 'port', (v) => parseInt(v, 10), 4576)
  .option('--host <host>', 'host', '127.0.0.1')
  .action((opts) => runServe({ db: opts.db, port: opts.port, host: opts.host }));

program
  .command('train')
  .description('Fit and export the linear-embedding rating profile')
  .requiredOption('--name <name>', 'profile name')
  .requiredOption('--out <file>', 'output profile JSON path')
  .option('--db <file>', 'SQLite database file', DEFAULT_DB)
  .option('--lambda <n>', 'ridge regularization strength', (v) => parseFloat(v), 1)
  .option('--holdout <frac>', 'fraction of duels held out for accuracy', (v) => parseFloat(v), 0.2)
  .action((opts) =>
    runTrain({ name: opts.name, out: opts.out, db: opts.db, lambda: opts.lambda, holdout: opts.holdout }),
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
