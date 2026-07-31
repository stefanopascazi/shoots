/**
 * shoots match — pairwise preference learning, the honest answer to "how do I
 * get ratings that reflect MY eye".
 *
 * The built-in rating profiles are priors: someone else's taste, or none at all.
 * This is the loop that replaces guessing with measurement —
 *
 *   import   a `shoots embeddings` bundle → a duel database
 *   serve    two photos at a time, keep one; active learning picks the pairs
 *   train    Bradley-Terry over the duels + a ridge head on the embeddings, so
 *            photographs you never judged get a score too
 *
 * — and it ends in `~/.shoots/profiles/<name>.json`, exactly where
 * `shoots rate --profile <name>` looks.
 *
 * `--name` is the through-line: it names the duel database, the profile, and the
 * `rate --profile` argument, so nothing has to be remembered between sessions.
 * Formerly the standalone `tools/match`, now folded into the CLI — the tool that
 * makes ratings honest should not require a toolchain to build.
 */
import type { Command } from 'commander';
import { matchDbPath, profilesDir } from '@shoots/core';
import { runImport, runServe, runTrain } from '@shoots/match';
import path from 'node:path';
import { logError, makeIo, markFailure, printHuman, printJson } from '../io.js';

/** A name that is safe as a filename and as a `rate --profile` argument. */
function assertUsableName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    throw new Error(
      `invalid --name '${name}': use letters, digits, dot, dash or underscore (it becomes a filename)`,
    );
  }
}

function dbFor(opts: { db?: string; name: string }): string {
  return opts.db ? path.resolve(opts.db) : matchDbPath(opts.name);
}

interface ImportOpts {
  data: string;
  images?: string;
  name: string;
  db?: string;
  json?: boolean;
}

interface ServeOpts {
  name: string;
  db?: string;
  port: number;
  host: string;
}

interface TrainOpts {
  name: string;
  out?: string;
  db?: string;
  lambda: number;
  holdout: number;
  json?: boolean;
}

async function importAction(opts: ImportOpts): Promise<void> {
  const io = makeIo(opts);
  assertUsableName(opts.name);

  const result = await runImport({ data: opts.data, images: opts.images, db: dbFor(opts) });

  if (opts.json) return printJson({ command: 'match import', ...result });
  printHuman(
    io,
    `Imported ${result.imported} photos from ${result.data} (model ${result.model}, dim ${result.dim}) → ${result.db}`,
  );
  printHuman(io, `Photos in DB: ${result.total} (${result.added} new)`);
}

async function serveAction(opts: ServeOpts): Promise<void> {
  const io = makeIo({});
  assertUsableName(opts.name);

  const { server, url, photos, comparisons } = await runServe({
    db: dbFor(opts),
    port: opts.port,
    host: opts.host,
  });

  printHuman(io, `Duel UI on ${url}  (Ctrl+C to stop)`);
  printHuman(io, `${photos} photos, ${comparisons} duels recorded so far`);

  // cli.tsx exits the process as soon as the action resolves — right for a
  // one-shot command, fatal for a server. Stay pending until it stops listening.
  await new Promise<void>((stopped) => {
    const shutDown = (): void => void server.close(() => stopped());
    process.once('SIGINT', shutDown);
    process.once('SIGTERM', shutDown);
    server.once('close', () => stopped());
  });
}

async function trainAction(opts: TrainOpts): Promise<void> {
  const io = makeIo(opts);
  assertUsableName(opts.name);

  const out = opts.out ? path.resolve(opts.out) : path.join(profilesDir(), `${opts.name}.json`);
  const result = await runTrain({
    name: opts.name,
    out,
    db: dbFor(opts),
    lambda: opts.lambda,
    holdout: opts.holdout,
  });

  if (opts.json) {
    return printJson({
      command: 'match train',
      name: opts.name,
      out: result.out,
      duels: result.duels,
      photos: result.photos,
      dim: result.dim,
      embeddingModel: result.embeddingModel,
      heldOutPairAccuracy: result.heldOutPairAccuracy,
    });
  }

  const accuracy = result.heldOutPairAccuracy;
  printHuman(io, `Trained '${opts.name}' from ${result.duels} duels over ${result.photos} photos`);
  printHuman(io, `  → ${result.out}  (dim ${result.dim}, model ${result.embeddingModel})`);
  printHuman(
    io,
    `  held-out pairwise accuracy: ${accuracy === null ? 'n/a (too few duels)' : accuracy}`,
  );
  printHuman(io, `Apply it: shoots rate <folder> --profile ${opts.name}`);
}

/** Commander swallows nothing: surface the message and set a failing exit code. */
function guard<T>(action: (opts: T) => Promise<void>): (opts: T) => Promise<void> {
  return async (opts: T) => {
    try {
      await action(opts);
    } catch (error) {
      logError(error instanceof Error ? error.message : String(error));
      markFailure();
    }
  };
}

export function registerMatchCommand(program: Command): void {
  const match = program
    .command('match')
    .description('Learn your eye from pairwise duels: import → serve → train (a rating profile)');

  match
    .command('import')
    .description('Load a `shoots embeddings` bundle into the duel database')
    .requiredOption('--data <file>', 'embeddings.json from `shoots embeddings --out <dir>`')
    .option('--name <name>', 'profile this database trains (names the DB)', 'my-eye')
    .option('--images <dir>', 'base folder to resolve image paths for the UI')
    .option('--db <file>', 'database file (default: ~/.shoots/match/<name>.db)')
    .option('--json', 'machine-readable JSON output on stdout')
    .action(guard(importAction));

  match
    .command('serve')
    .description('Open the local duel UI — two photos at a time, keep one')
    .option('--name <name>', 'profile this database trains (names the DB)', 'my-eye')
    .option('--db <file>', 'database file (default: ~/.shoots/match/<name>.db)')
    .option('--port <n>', 'port', (v) => parseInt(v, 10), 4576)
    .option('--host <host>', 'host — local by default', '127.0.0.1')
    .action(guard(serveAction));

  match
    .command('train')
    .description('Fit the rating profile from the duels recorded so far')
    .option('--name <name>', 'profile name (also names the DB and `rate --profile`)', 'my-eye')
    .option('--out <file>', 'profile path (default: ~/.shoots/profiles/<name>.json)')
    .option('--db <file>', 'database file (default: ~/.shoots/match/<name>.db)')
    .option('--lambda <n>', 'ridge regularization strength', (v) => parseFloat(v), 1)
    .option('--holdout <frac>', 'fraction of duels held out for accuracy', (v) => parseFloat(v), 0.2)
    .option('--json', 'machine-readable JSON output on stdout')
    .action(guard(trainAction));
}
