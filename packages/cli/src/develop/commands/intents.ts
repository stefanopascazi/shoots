/**
 * `develop intents calibrate | list` — the intent thresholds, in the
 * photographer's own terms.
 *
 * `calibrate` decodes a sample of the finished edits in a training dataset,
 * reads where each one's highlights, midtones and shadows landed, and saves the
 * thresholds the intents then use (intents/calibrate.ts says how). `list` shows
 * the intents and the thresholds in force.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { developExportPath, developIntentsPath } from '@shoots/core';
import { loadDataset } from '../dataset/load.js';
import { sessionKey } from '../develop/session.js';
import { frameHistogram } from '../intents/frame.js';
import { DEFAULT_THRESHOLDS, MIN_LOOKS, thresholdsFromLooks, type IntentCalibration, type IntentThresholds } from '../intents/calibrate.js';
import { INTENTS } from '../intents/intents.js';
import { lookOf, toneFromDevelop } from '../look/tone.js';
import { resolveRawDeveloper } from '../../rawDeveloper.js';
import { logError, logWarn, makeIo, printHuman, printJson } from '../../io.js';

/** The thresholds in force: the calibration on disk, or the defaults. */
export async function loadIntentThresholds(
  file = developIntentsPath(),
): Promise<{ thresholds: IntentThresholds; calibrated: boolean; strength: number }> {
  if (!existsSync(file)) return { thresholds: DEFAULT_THRESHOLDS, calibrated: false, strength: 1 };
  const cal = JSON.parse(await readFile(file, 'utf8')) as IntentCalibration;
  if (cal.type !== 'develop-intents') throw new Error(`${file} is not an intents calibration`);
  return { thresholds: { ...DEFAULT_THRESHOLDS, ...cal.thresholds }, calibrated: true, strength: cal.strength ?? 1 };
}

/** Up to `n` frames, round-robin over shoots so one big wedding does not set every bound. */
export function sampleByShoot<T extends { file: string }>(records: readonly T[], n: number): T[] {
  const byShoot = new Map<string, T[]>();
  for (const r of records) byShoot.set(sessionKey(r.file), [...(byShoot.get(sessionKey(r.file)) ?? []), r]);
  // Within a shoot, visit frames in a low-discrepancy order (golden-ratio
  // stride) so the first picks span the whole take instead of its opening test shots.
  const queues = [...byShoot.values()].map((q) => q.map((r, j) => [(j * 0.6180339887) % 1, r] as const).sort((a, b) => a[0] - b[0]).map(([, r]) => r));
  const out: T[] = [];
  for (let round = 0; out.length < n && queues.some((q) => q.length > round); round++) {
    for (const q of queues) if (q[round] && out.length < n) out.push(q[round]!);
  }
  return out;
}

export interface IntentsCalibrateArgs {
  data?: string;
  sample?: number;
  out?: string;
  json?: boolean;
  verbose?: boolean;
}

export async function runIntentsCalibrate(args: IntentsCalibrateArgs): Promise<void> {
  const io = makeIo(args);
  if (!resolveRawDeveloper()) {
    logError('calibrating intents decodes your edited photographs — run `shoots setup` for the RAW developer');
    process.exitCode = 2;
    return;
  }
  const dataPath = path.resolve(args.data ?? developExportPath());
  if (!existsSync(dataPath)) {
    logError(`no dataset at ${dataPath} — pass --data, or run \`shoots develop init\` first`);
    process.exitCode = 2;
    return;
  }
  const dataset = await loadDataset(dataPath);
  // Colour edits only: a black-and-white conversion moves every tone for reasons
  // of its own, and its histogram says nothing about how this photographer
  // treats highlights in colour.
  const edited = dataset.results.filter((r) => r.edited !== false && (r.treatment ?? 'color') === 'color' && r.asShot);
  const sample = sampleByShoot(edited, args.sample ?? 150);
  printHuman(io, `Reading ${sample.length} of your ${edited.length} colour edits…`);

  const looks: number[][] = [];
  const shoots = new Set<string>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < sample.length) {
      const r = sample[next++]!;
      try {
        const hist = await frameHistogram(r.file, r.develop, r.asShot);
        looks.push(lookOf(hist, toneFromDevelop(r.develop)));
        shoots.add(sessionKey(r.file));
      } catch (err) {
        if (args.verbose) logWarn(`${r.file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));

  if (looks.length < MIN_LOOKS) {
    logError(`only ${looks.length} edits could be read (need ${MIN_LOOKS}) — are the photographs online?`);
    process.exitCode = 2;
    return;
  }
  const calibration: IntentCalibration = {
    type: 'develop-intents',
    at: new Date().toISOString(),
    frames: looks.length,
    shoots: shoots.size,
    thresholds: thresholdsFromLooks(looks),
    // A recalibration measures the photographer again; the strength they tuned by eye stays.
    ...(existsSync(developIntentsPath()) ? { strength: (await loadIntentThresholds()).strength } : {}),
  };
  const out = path.resolve(args.out ?? developIntentsPath());
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(calibration, null, 2) + '\n', 'utf8');

  if (io.json) {
    printJson({ command: 'develop-intents-calibrate', out, ...calibration });
    return;
  }
  printHuman(io, `\nIntent thresholds from ${looks.length} edits in ${shoots.size} shoots → ${out}`);
  printThresholds(io, calibration.thresholds);
}

function printThresholds(io: ReturnType<typeof makeIo>, t: IntentThresholds): void {
  const cv = (v: number): string => `${Math.round(v * 255)}`.padStart(3);
  printHuman(io, `  highlights kept under   ${cv(t.highlightCap)}/255 (99th percentile)  preserve-highlights`);
  printHuman(io, `  shadows opened to       ${cv(t.shadowFloor)}/255 (5th percentile)    open-shadows`);
  printHuman(io, `  shadows kept under      ${cv(t.deepShadowCap)}/255 (5th percentile)    keep-shadows-deep`);
  printHuman(io, `  midtones between        ${cv(t.midLow)}–${Math.round(t.midHigh * 255)}/255 (median)        expose-correctly`);
}

export interface IntentsSetArgs {
  strength: number;
  json?: boolean;
  verbose?: boolean;
}

/** Persist the default intent strength, once tuned by eye in the editor. */
export async function runIntentsSet(args: IntentsSetArgs): Promise<void> {
  const io = makeIo(args);
  if (!(args.strength >= 0 && args.strength <= 1)) {
    logError(`invalid --strength ${args.strength} (use 0..1)`);
    process.exitCode = 2;
    return;
  }
  const file = developIntentsPath();
  const current: IntentCalibration = existsSync(file)
    ? (JSON.parse(await readFile(file, 'utf8')) as IntentCalibration)
    : { type: 'develop-intents', at: new Date().toISOString(), frames: 0, shoots: 0, thresholds: DEFAULT_THRESHOLDS };
  current.strength = args.strength;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(current, null, 2) + '\n', 'utf8');
  if (io.json) printJson({ command: 'develop-intents-set', file, strength: args.strength });
  else printHuman(io, `Intents now apply at strength ${args.strength} by default (${file})`);
}

export interface IntentsListArgs {
  json?: boolean;
  verbose?: boolean;
}

export async function runIntentsList(args: IntentsListArgs): Promise<void> {
  const io = makeIo(args);
  const { thresholds, calibrated, strength } = await loadIntentThresholds();
  if (io.json) {
    printJson({
      command: 'develop-intents-list',
      calibrated,
      strength,
      thresholds,
      intents: INTENTS.map((i) => ({ id: i.id, label: i.label, controls: i.controls })),
    });
    return;
  }
  for (const i of INTENTS) printHuman(io, `${i.id.padEnd(22)} ${i.label.padEnd(22)} moves ${i.controls.join(', ')}`);
  printHuman(io, calibrated ? '\nThresholds measured on your edits:' : '\nDefault thresholds — `shoots develop intents calibrate` measures yours:');
  printThresholds(io, thresholds);
  printHuman(io, `  default strength        ${strength}  (\`develop intents set --strength\` changes it)`);
}
