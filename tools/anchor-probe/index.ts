/**
 * anchor-probe — is a slider a *correction toward a target*, and how strong?
 *
 *   bun tools/anchor-probe/index.ts --data train_v2.jsonl
 *
 * The develop predictor learns `slider = f(features)` as a shrunk regression, so
 * its output is a conditional mean: timid everywhere and timidest exactly where
 * the correction needs to be large. A frame needing −1.5 stops comes back with
 * −0.14, and no amount of de-shrinking fixes it — that mechanism rescales a
 * prediction, it cannot make a flat one point somewhere.
 *
 * The alternative formulation, which extrapolates by construction:
 *
 *     slider = gain · (target − current)
 *
 * where `current` is a measured property of *this* photograph, `target` is the
 * photographer's constant, and `gain` says how fully they close the gap. A frame
 * two stops above the target gets −2 by arithmetic, without the fit ever having
 * seen a frame that wrong.
 *
 * `gain = 1` is a full correction; the interesting question this tool answers is
 * whether the photographer's real gain is anywhere near it, per slider, and
 * whether anchoring beats the shrunk regression on the frames that matter.
 *
 * **`tail skill` is the column to read.** Ordinary skill is MAE over everything,
 * which is the metric that prefers the timid answer — it is reported for
 * continuity, not because it is the target. The tail column is the same skill
 * computed over the worst fifth of frames, the ones whose correction is largest.
 * That is where a preset and a prediction actually differ.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { COLOR_FEATURE_NAMES } from '@shoots/imaging';
import { correlation, foldsByGroup, mean, sd } from '../lib/fit.js';

/**
 * Slider → the scene property it plausibly corrects, and how to read it.
 *
 * `log2` for anything that behaves multiplicatively: a stop of exposure is a
 * doubling, so the gap has to be measured in the space the slider moves in, or
 * the same gain cannot describe a dark frame and a bright one at once.
 */
const ANCHORS: { param: string; feature: string; log2: boolean }[] = [
  { param: 'Exposure2012', feature: 'lumaMean', log2: true },
  { param: 'Exposure2012', feature: 'lumaMedian', log2: true },
  { param: 'Highlights2012', feature: 'lumaP99', log2: false },
  { param: 'Whites2012', feature: 'clipHigh', log2: false },
  { param: 'Shadows2012', feature: 'shadowFloor', log2: false },
  { param: 'Blacks2012', feature: 'clipShadow', log2: false },
  { param: 'Contrast2012', feature: 'lumaStd', log2: false },
  { param: 'Vibrance', feature: 'satMean', log2: false },
  { param: 'Saturation', feature: 'satMean', log2: false },
  { param: 'Clarity2012', feature: 'detailCoarse', log2: false },
  { param: 'Texture', feature: 'detailFine', log2: false },
];

interface Row {
  session: string;
  x: number;
  y: number;
}

const EPS = 1e-6;

/** Skill over a subset, against the training-fold constant. */
function skill(rows: Row[], predict: (r: Row) => number, constant: number, pick: (r: Row) => boolean): number {
  let model = 0;
  let base = 0;
  for (const r of rows) {
    if (!pick(r)) continue;
    model += Math.abs(predict(r) - r.y);
    base += Math.abs(constant - r.y);
  }
  return base > EPS ? 1 - model / base : 0;
}

function main(): void {
  const argv = process.argv.slice(2);
  const dataArg = argv[argv.indexOf('--data') + 1];
  if (argv.indexOf('--data') < 0 || !dataArg) throw new Error('usage: bun tools/anchor-probe/index.ts --data <train.jsonl>');
  const folds = Number(argv[argv.indexOf('--folds') + 1] ?? 5) || 5;
  const shuffles = Number(argv[argv.indexOf('--shuffles') + 1] ?? 20) || 20;

  const all = readFileSync(path.resolve(dataArg), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .filter((r: any) => r.edited !== false && r.features?.length && r.develop);
  console.log(`${all.length} edited frames\n`);
  console.log('  slider          anchor          r      gain    target   | skill   tail skill | ridge-ish  tail');

  for (const a of ANCHORS) {
    const fi = COLOR_FEATURE_NAMES.indexOf(a.feature);
    if (fi < 0) continue;
    const rows: Row[] = [];
    for (const r of all as any[]) {
      const v = r.develop[a.param];
      const f = r.features[fi];
      if (!Number.isFinite(v) || !Number.isFinite(f)) continue;
      if (a.log2 && f <= EPS) continue;
      rows.push({ session: path.dirname(r.file), x: a.log2 ? Math.log2(f) : f, y: v });
    }
    if (rows.length < 100 || sd(rows.map((r) => r.y)) < EPS) continue;

    const r = correlation(rows.map((v) => v.x), rows.map((v) => v.y));
    // Unshrunk OLS slope: the gain, in slider units per unit of the anchor.
    const gain = (r * sd(rows.map((v) => v.y))) / (sd(rows.map((v) => v.x)) || 1);

    // The frames whose own correction is largest — where a preset and a
    // prediction visibly differ, and the only place the complaint lives.
    const ys = rows.map((v) => Math.abs(v.y - mean(rows.map((q) => q.y)))).sort((p, q) => p - q);
    const tailCut = ys[Math.floor(ys.length * 0.8)]!;
    const isTail = (v: Row): boolean => Math.abs(v.y - mean(rows.map((q) => q.y))) >= tailCut;

    const acc = { anchor: [] as number[], anchorTail: [] as number[], shrunk: [] as number[], shrunkTail: [] as number[] };
    for (let s = 0; s < shuffles; s++) {
      const foldOf = foldsByGroup(rows.map((v) => v.session), folds, s + 1);
      for (let f = 0; f < folds; f++) {
        const tr = rows.filter((v) => foldOf.get(v.session) !== f);
        const te = rows.filter((v) => foldOf.get(v.session) === f);
        if (tr.length < 20 || te.length === 0) continue;
        const ybar = mean(tr.map((v) => v.y));
        const xbar = mean(tr.map((v) => v.x));
        const rr = correlation(tr.map((v) => v.x), tr.map((v) => v.y));
        const g = (rr * sd(tr.map((v) => v.y))) / (sd(tr.map((v) => v.x)) || 1);
        // Anchored: full unshrunk gain. Shrunk: the same fit damped by r², which
        // is roughly what a ridge picked on held-out MAE settles at.
        const anchored = (v: Row): number => ybar + g * (v.x - xbar);
        const shrunk = (v: Row): number => ybar + g * rr * rr * (v.x - xbar);
        acc.anchor.push(skill(te, anchored, ybar, () => true));
        acc.shrunk.push(skill(te, shrunk, ybar, () => true));
        if (te.some(isTail)) {
          acc.anchorTail.push(skill(te, anchored, ybar, isTail));
          acc.shrunkTail.push(skill(te, shrunk, ybar, isTail));
        }
      }
    }

    const target = a.log2 ? 2 ** (mean(rows.map((v) => v.x)) - mean(rows.map((v) => v.y)) / (gain || 1)) : NaN;
    console.log(
      `  ${a.param.padEnd(15)} ${a.feature.padEnd(14)} ${r.toFixed(3).padStart(6)} ${gain.toFixed(2).padStart(7)} ` +
        `${(Number.isFinite(target) ? target.toFixed(3) : '—').padStart(8)}   | ` +
        `${mean(acc.anchor).toFixed(3).padStart(6)}  ${mean(acc.anchorTail).toFixed(3).padStart(9)} | ` +
        `${mean(acc.shrunk).toFixed(3).padStart(8)}  ${mean(acc.shrunkTail).toFixed(3).padStart(6)}`,
    );
  }
  console.log(
    '\n  gain is the unshrunk slope: slider units per unit of anchor. For Exposure in log2\n' +
      '  luminance, −1 would be a full correction to a fixed target.\n' +
      '  tail skill is over the worst fifth of frames — the ones the complaint is about.',
  );
}

main();
