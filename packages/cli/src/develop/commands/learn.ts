/**
 * `develop learn <shoot>` — fold a shoot you have developed back into training.
 *
 * `calibrate` fixes what the model is wrong by *on average*. It cannot fix what
 * changes from photograph to photograph, because a constant cannot track a
 * variable — and the part that varies is most of what a photographer would call
 * their eye. Only refitting the model can move that, and refitting needs the
 * corrected shoot inside the training set.
 *
 * Everything needed is already on disk. `develop edit` left the shoot's features
 * (CLIP, colour, session) under ~/.shoots/develop/export/shooting/<shoot>/ and
 * the prediction beside them; the photographs have since been through Lightroom.
 * So the features are reused untouched, the targets are re-read from the files as
 * they are now, and nothing is recomputed — an export that cost minutes becomes
 * a pass over sidecars.
 *
 * The part that makes this different from "add more photos to the catalog" is
 * the weight. Each frame enters the fit scaled by how much of the prediction the
 * photographer had to change, which is both the useful signal and the safeguard —
 * see dataset/weight.ts for why those are the same thing.
 */
import path from 'node:path';
import { createWriteStream, existsSync } from 'node:fs';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { developExportPath, developProfilePath, developShootDir } from '@shoots/core';
import { loadDataset } from '../dataset/load.js';
import { refreshTargets, refreshedMeta } from '../dataset/refresh.js';
import {
  DEFAULT_MAX_WEIGHT,
  DEFAULT_MIN_WEIGHT,
  paramSpread,
  weighByCorrection,
  type WeightedRecord,
} from '../dataset/weight.js';
import { runTrain } from './train.js';
import { DEFAULT_EDITOR, EDITOR_IDS } from '../adapters/registry.js';
import { logError, logWarn, makeIo, printHuman, printJson } from '../../io.js';
import { ensureExiftoolReady } from '../../tools.js';
import type { DevelopDataset, DevelopExportResult } from '../types.js';
import type { Prediction } from '../predict.js';

export interface LearnArgs {
  /** Training dataset to fold into (default: ~/.shoots/develop/export/export.jsonl). */
  data?: string;
  /** Profile to refit (default: ~/.shoots/develop/profile/export.json). */
  out?: string;
  /** The shoot's working directory, when it is not the conventional one. */
  shootDir?: string;
  editor?: string;
  name: string;
  lambda: string;
  folds: number;
  groupBy?: string;
  gateThreshold?: number;
  embeddingDim?: number;
  all?: boolean;
  minWeight?: number;
  maxWeight?: number;
  /** `--no-train`: commander sets this to false, meaning fold in but do not refit. */
  train?: boolean;
  dryRun?: boolean;
  json?: boolean;
  verbose?: boolean;
}

/** The dataset-level facts two datasets must agree on to be merged at all. */
function assertMergeable(base: DevelopDataset, shoot: DevelopDataset): string | null {
  if (base.model !== shoot.model) return `embedding model differs ('${base.model}' vs '${shoot.model}')`;
  if (base.dim !== shoot.dim) return `embedding dim differs (${base.dim} vs ${shoot.dim})`;
  if (base.colorDim !== shoot.colorDim) return `colour feature count differs (${base.colorDim} vs ${shoot.colorDim})`;
  if (base.baseline !== shoot.baseline) {
    return `baseline render differs ('${base.baseline}' vs '${shoot.baseline}') — the colour features are not comparable across baselines`;
  }
  return null;
}

export async function runLearn(targetPath: string, args: LearnArgs): Promise<void> {
  const io = makeIo(args);
  const editorId = args.editor ?? DEFAULT_EDITOR;
  if (!EDITOR_IDS.includes(editorId)) {
    logError(`unknown --editor '${editorId}' (available: ${EDITOR_IDS.join(', ')})`);
    process.exitCode = 2;
    return;
  }

  const folder = path.basename(path.resolve(targetPath));
  const workDir = args.shootDir ? path.resolve(args.shootDir) : developShootDir(folder);
  const shootData = path.join(workDir, 'export.jsonl');
  const predictionPath = path.join(workDir, 'prediction.json');
  const dataPath = path.resolve(args.data ?? developExportPath());
  const profilePath = path.resolve(args.out ?? developProfilePath());

  for (const [file, what] of [
    [shootData, "the shoot's features"],
    [predictionPath, 'the prediction record'],
  ] as const) {
    if (!existsSync(file)) {
      logError(
        `no ${what} at ${file} — \`develop learn\` folds back a shoot that \`shoots develop edit ${targetPath}\` ` +
          'produced; run that first, develop the photographs, then come back',
      );
      process.exitCode = 2;
      return;
    }
  }
  if (!existsSync(dataPath)) {
    logError(`no training dataset at ${dataPath} — run \`shoots develop init <catalog>\` first, or pass --data`);
    process.exitCode = 2;
    return;
  }

  const base = await loadDataset(dataPath);
  const shoot = await loadDataset(shootData);
  const mismatch = assertMergeable(base, shoot);
  if (mismatch) {
    logError(`cannot fold this shoot into ${dataPath}: ${mismatch}`);
    process.exitCode = 2;
    return;
  }

  const payload = JSON.parse(await readFile(predictionPath, 'utf8')) as { predictions?: Prediction[] };
  const predictions = payload.predictions ?? [];
  if (predictions.length === 0) {
    logError(`${predictionPath}: no predictions found — nothing to measure the corrections against`);
    process.exitCode = 2;
    return;
  }
  if (!(await ensureExiftoolReady(io))) return;

  // The shoot was exported *before* it was developed, so its targets are the
  // blank page the photographer has since written on. Features stay as they are.
  printHuman(io, `[1/3] Re-reading ${shoot.results.length} files as they are now`);
  const refreshed = await refreshTargets(shoot.results, io, { editor: editorId, carryLooks: shoot.looks });
  const nowEdited = refreshed.records.filter((r) => r.edited !== false);
  if (nowEdited.length === 0) {
    logError(
      `none of the ${shoot.results.length} files in ${targetPath} carry a real edit yet — ` +
        'develop them first, then fold the shoot back in',
    );
    process.exitCode = 2;
    return;
  }

  // Scale corrections against how much each parameter varies across the
  // photographer's own catalog, not against the shoot: a shoot is too small to
  // say what "a lot of Contrast" means, and the catalog already knows.
  printHuman(io, `[2/3] Weighting by how much of the prediction you changed`);
  const weighting = weighByCorrection(nowEdited, predictions, paramSpread(base.results), {
    minWeight: args.minWeight,
    maxWeight: args.maxWeight,
  });
  const weightOf = new Map(weighting.records.map((r) => [r.file, r.weight]));
  if (weighting.unmatched.length > 0) {
    logWarn(
      `${weighting.unmatched.length} developed file(s) have no matching prediction — folded in at weight 1 ` +
        '(they are ordinary edits, just not measured ones)',
    );
  }

  // Same file twice is the same photograph developed again: the newer state wins,
  // exactly as it does in the feedback journal.
  const merged = new Map<string, DevelopExportResult>(base.results.map((r) => [r.file, r]));
  for (const record of refreshed.records) {
    const weight = weightOf.get(record.file);
    merged.set(record.file, weight === undefined ? record : { ...record, weight });
  }
  const replaced = refreshed.records.filter((r) => base.results.some((b) => b.file === r.file)).length;

  const summary = {
    shoot: folder,
    files: shoot.results.length,
    edited: nowEdited.length,
    replaced,
    added: refreshed.records.length - replaced,
    datasetBefore: base.results.length,
    datasetAfter: merged.size,
    medianCorrection: Math.round(weighting.medianZ * 1e4) / 1e4,
  };

  if (args.dryRun) {
    if (io.json) printJson({ command: 'develop-learn', dryRun: true, ...summary, weights: weighting.records });
    else {
      printHuman(io, '\nDry run — nothing written.\n');
      reportWeights(weighting.records, summary);
      printHuman(io, `\n  would write ${merged.size} records → ${dataPath}`);
      printHuman(io, `  would refit  → ${profilePath}`);
    }
    return;
  }

  printHuman(io, `[3/3] Folding ${refreshed.records.length} records into ${dataPath}`);
  const looks = new Map<string, string>(Object.entries(base.looks ?? {}));
  for (const [name, xml] of refreshed.looks) looks.set(name, xml);
  await writeDataset(dataPath, [...merged.values()], base, looks, summary);

  if (!io.json) reportWeights(weighting.records, summary);

  if (args.train === false) {
    if (io.json) printJson({ command: 'develop-learn', ...summary, trained: false, weights: weighting.records });
    else printHuman(io, `\nDataset updated. \`shoots develop train --data ${dataPath}\` when you want the refit.`);
    return;
  }

  printHuman(io, `\nRefitting the profile → ${profilePath}`);
  await runTrain({
    data: dataPath,
    name: args.name,
    out: profilePath,
    lambda: args.lambda,
    folds: args.folds,
    groupBy: args.groupBy,
    gateThreshold: args.gateThreshold,
    embeddingDim: args.embeddingDim,
    all: args.all,
  });
  if ((process.exitCode ?? 0) !== 0) return;

  if (io.json) {
    printJson({ command: 'develop-learn', ...summary, trained: true, profile: profilePath, weights: weighting.records });
    return;
  }
  // A refit replaces the model the offsets were measured against, so whatever
  // `calibrate` had learned describes something that no longer exists.
  printHuman(io, '\nThe profile has been refitted, so any calibration on it is stale —');
  printHuman(io, 'develop a shoot, run `develop feedback`, then `develop calibrate` again.');
}

async function writeDataset(
  file: string,
  records: DevelopExportResult[],
  base: DevelopDataset,
  looks: Map<string, string>,
  summary: Record<string, unknown>,
): Promise<void> {
  const tmp = `${file}.tmp`;
  const out = createWriteStream(tmp, { encoding: 'utf8' });
  const write = async (line: string): Promise<void> => {
    if (!out.write(line)) await once(out, 'drain');
  };
  for (const record of records) await write(JSON.stringify(record) + '\n');
  await write(JSON.stringify(refreshedMeta(base, looks, summary as Record<string, number>)) + '\n');
  out.end();
  await once(out, 'finish');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, file);
}

function reportWeights(records: readonly WeightedRecord[], summary: { edited: number; medianCorrection: number }): void {
  const w = process.stderr;
  const sorted = [...records].sort((a, b) => b.weight - a.weight);
  const buckets = { heavy: 0, normal: 0, light: 0 };
  for (const r of records) {
    if (r.weight >= 1.5) buckets.heavy++;
    else if (r.weight > 0.6) buckets.normal++;
    else buckets.light++;
  }

  w.write(`\n  ${summary.edited} developed frames, weighted by how much you changed:\n`);
  w.write(`    ${buckets.heavy} you overruled     (weight ≥ 1.5 — these drive the refit)\n`);
  w.write(`    ${buckets.normal} you adjusted      (around 1, like an ordinary catalog edit)\n`);
  w.write(`    ${buckets.light} you accepted      (weight ≤ 0.6 — mostly our own output coming back)\n`);

  const show = [...sorted.slice(0, 3), ...sorted.slice(-2)];
  const seen = new Set<string>();
  w.write('\n    file                                weight   correction\n');
  for (const r of show) {
    if (seen.has(r.file)) continue;
    seen.add(r.file);
    w.write(`    ${path.basename(r.file).padEnd(34)} ${r.weight.toFixed(2).padStart(6)}   ${r.z.toFixed(2).padStart(10)}\n`);
  }
  w.write(`    (correction 1.00 = the median for this shoot, ${summary.medianCorrection} in standardized units)\n`);
  w.write('\n  Frames you accepted count least on purpose: an edit made *from* the\n');
  w.write('  prediction is partly the prediction itself, and training on it would\n');
  w.write('  teach the model that its own output was right.\n');
}
