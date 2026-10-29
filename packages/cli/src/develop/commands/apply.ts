/**
 * `develop apply --catalog <export>` — predictions for the Lightroom plug-in.
 *
 * The plug-in path of `develop edit`: the selection arrives as a catalog export
 * (each photo's current settings, so "already edited" is read the way training
 * reads it), the shoot is exported and predicted as usual, and the result is
 * printed as the settings tables `applyDevelopSettings()` takes. Nothing is
 * written beside the photographs; the plug-in writes the catalog and asks
 * before touching a photo that already carries an edit.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { developProfilePath } from '@shoots/core';
import { runDevelopExport, BASELINES } from '../export.js';
import { runPredict } from './predict.js';
import { loadDataset } from '../dataset/load.js';
import { loadCatalogExport } from '../adapters/lightroom/catalog.js';
import { lightroomSettings, type LightroomSettings } from '../adapters/lightroom/emit.js';
import { logError, makeIo, printHuman, printJson } from '../../io.js';
import type { Prediction } from '../predict.js';
import type { DevelopProfile } from '../types.js';
import { foldRunIntoShoot, shootWorkDir } from '../shoot.js';

export interface ApplyArgs {
  catalog: string;
  profile?: string;
  treatment: string;
  /** Default: the baseline the profile was trained on — the features only compare within one. */
  baseline?: string;
  model: string;
  concurrency: string;
  json?: boolean;
  verbose?: boolean;
}

export interface ApplyResult {
  file: string;
  treatment: Prediction['treatment'];
  /** The photo already carries a deliberate edit: the plug-in asks before replacing it. */
  edited: boolean;
  settings: LightroomSettings;
  /**
   * The creative profile (e.g. "Adobe Color") when the profile holds only its
   * name: the plug-in takes the full Look from a photo in the catalog that uses it.
   */
  look?: string;
}

const failed = (): boolean => (process.exitCode ?? 0) !== 0;

export async function runApply(args: ApplyArgs): Promise<void> {
  const io = makeIo(args);
  const profilePath = path.resolve(args.profile ?? developProfilePath());
  if (!existsSync(profilePath)) {
    logError(`no profile at ${profilePath} — train one first (the app's Training screen, or \`shoots develop init\`)`);
    process.exitCode = 2;
    return;
  }
  const baseline = args.baseline ?? (JSON.parse(await readFile(profilePath, 'utf8')) as DevelopProfile).baseline ?? 'external';
  if (!BASELINES.includes(baseline as (typeof BASELINES)[number])) {
    logError(`unknown --baseline '${baseline}' (available: ${BASELINES.join(', ')})`);
    process.exitCode = 2;
    return;
  }

  let files: string[];
  let shoot: string;
  try {
    const data = await loadCatalogExport(args.catalog);
    files = data.photos.map((p) => p.path);
    shoot = data.folder || path.dirname(files[0] ?? '.');
  } catch (err) {
    logError(`could not read the catalog export: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }
  if (files.length === 0) {
    logError('the catalog export names no photos');
    process.exitCode = 2;
    return;
  }

  // Kept per shoot, as `develop edit` does: `develop refine` reads the predictions back
  // later. This run is written beside them, then folded in by file.
  const workDir = shootWorkDir(shoot);
  const datasetPath = path.join(workDir, 'run.export.jsonl');
  const predictionPath = path.join(workDir, 'run.prediction.json');
  await mkdir(workDir, { recursive: true });

  await runDevelopExport('', {
    model: args.model,
    concurrency: args.concurrency,
    baseline,
    catalog: args.catalog,
    files,
    out: datasetPath,
    json: false,
    quiet: true,
    verbose: args.verbose,
  });
  if (failed()) return;

  await runPredict({ data: datasetPath, profile: profilePath, treatment: args.treatment, out: predictionPath, applyMarks: false });
  if (failed()) return;

  const { profile, predictions } = JSON.parse(await readFile(predictionPath, 'utf8')) as { profile: string; predictions: Prediction[] };
  const dataset = await loadDataset(datasetPath);
  await foldRunIntoShoot(workDir, datasetPath, predictionPath);
  await rm(datasetPath, { force: true });
  await rm(predictionPath, { force: true });
  const edited = new Map(dataset.results.map((r) => [r.file, r.edited === true]));
  const results: ApplyResult[] = predictions.map((p) => {
    const settings = lightroomSettings(p.develop, p.treatment, p.render);
    const look = !settings.Look && p.render?.look ? { look: p.render.look } : {};
    return { file: p.file, treatment: p.treatment, edited: edited.get(p.file) ?? false, settings, ...look };
  });
  // Offline frames, and those the export could not read, get no prediction.
  const key = (f: string): string => (process.platform === 'win32' ? path.resolve(f).toLowerCase() : path.resolve(f));
  const predicted = new Set(results.map((r) => key(r.file)));
  const errors = files
    .filter((f) => !predicted.has(key(f)))
    .map((file) => ({ file, error: 'no prediction: the file is offline or could not be read' }));

  if (io.json) {
    printJson({ command: 'develop-apply', profile, shootDir: workDir, results, errors });
    return;
  }
  printHuman(io, `${results.length} prediction(s) from profile '${profile}' (${results.filter((r) => r.edited).length} already edited).`);
  for (const e of errors) printHuman(io, `  skipped ${e.file}: ${e.error}`);
}
