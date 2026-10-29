/**
 * A shoot's working directory under ~/.shoots/develop/export/shooting, and
 * folding a new prediction run into it.
 *
 * The directory used to be named after the folder alone, so two shoots called
 * "Selects" in different places shared one and overwrote each other. It now
 * carries a digest of the full path; a shoot started under the old name keeps
 * using it, so a loop already open is not lost.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { developShootDir, developShootsDir } from '@shoots/core';
import { loadDataset } from './dataset/load.js';
import { refreshedMeta } from './dataset/refresh.js';
import type { Prediction } from './predict.js';
import type { DevelopDataset } from './types.js';

/** The working directory for the shoot at `folder`, digest-named unless an old one exists. */
export function shootWorkDir(folder: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = path.resolve(folder);
  const key = platform === 'win32' ? resolved.toLowerCase() : resolved;
  const digest = createHash('sha1').update(key).digest('hex').slice(0, 8);
  const name = path.basename(resolved) || 'root';
  const current = path.join(developShootsDir(), `${name}-${digest}`);
  const legacy = developShootDir(name);
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

/** A prediction record as `develop predict --out` writes it. */
export interface PredictionRecord {
  command: string;
  at: string;
  profile: string;
  /** The folder the shoot was developed from, as the plug-in named it. */
  folder?: string;
  predictions: (Prediction & { predictedAt?: string })[];
  [key: string]: unknown;
}

/** Same dataset space: records from both can sit in one file. */
function sameSpace(a: DevelopDataset, b: DevelopDataset): boolean {
  return a.model === b.model && a.dim === b.dim && a.colorDim === b.colorDim && a.baseline === b.baseline;
}

/**
 * Fold the run just written (`runDataset`, `runPrediction`) into the shoot's
 * `export.jsonl` and `prediction.json`, by file, the newest run winning.
 *
 * Developing part of a folder and then another part must not lose the first
 * part's predictions: `feedback` and `learn` read them back. Each prediction
 * keeps the instant it was made, which decides whether it is still held out.
 */
export async function foldRunIntoShoot(workDir: string, runDataset: string, runPrediction: string, folder?: string): Promise<void> {
  const datasetPath = path.join(workDir, 'export.jsonl');
  const predictionPath = path.join(workDir, 'prediction.json');

  const run = await loadDataset(runDataset);
  const old = existsSync(datasetPath) ? await loadDataset(datasetPath).catch(() => undefined) : undefined;
  const keep = old && sameSpace(old, run) ? old : undefined;
  const records = new Map((keep?.results ?? []).map((r) => [r.file, r]));
  for (const r of run.results) records.set(r.file, r);
  const looks = new Map(Object.entries({ ...(keep?.looks ?? {}), ...(run.looks ?? {}) }));
  const lines = [...records.values()].map((r) => JSON.stringify(r));
  lines.push(JSON.stringify(refreshedMeta(run, looks, { total: records.size })));
  await writeFile(`${datasetPath}.tmp`, lines.join('\n') + '\n', 'utf8');
  await rename(`${datasetPath}.tmp`, datasetPath);

  const fresh = JSON.parse(await readFile(runPrediction, 'utf8')) as PredictionRecord;
  const stamp = (p: PredictionRecord['predictions'][number], at: string) => ({ ...p, predictedAt: p.predictedAt ?? at });
  const byFile = new Map<string, PredictionRecord['predictions'][number]>();
  if (keep && existsSync(predictionPath)) {
    const prior = JSON.parse(await readFile(predictionPath, 'utf8')) as PredictionRecord;
    for (const p of prior.predictions ?? []) byFile.set(p.file, stamp(p, prior.at));
  }
  for (const p of fresh.predictions) byFile.set(p.file, stamp(p, fresh.at));
  const merged: PredictionRecord = { ...fresh, ...(folder ? { folder: path.resolve(folder) } : {}), count: byFile.size, predictions: [...byFile.values()] };
  await writeFile(`${predictionPath}.tmp`, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  await rename(`${predictionPath}.tmp`, predictionPath);
}
