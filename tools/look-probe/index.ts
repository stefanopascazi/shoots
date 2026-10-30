/**
 * look-probe — does learning the photographer's *look* beat learning their sliders?
 *
 *   bun tools/look-probe/index.ts --data train_v2.jsonl [--cache look-hist.json]
 *
 * The develop predictor learns slider values. When the photographer applied
 * near-fixed sliders, that is a preset by construction: the slider never varied,
 * so no fit can learn when to move it. The look — where the histogram lands on
 * screen after the edit — is what they were holding constant, and it varies far
 * less across frames than the sliders that produced it.
 *
 * This tool compares, on whole shoots held out:
 *
 *   preset       training mean of each tone slider
 *   slider-ridge ridge from scene features to each slider (the current idea, simplified)
 *   look-const   solver onto the training mean look
 *   look-scene   solver onto a look predicted from the scene
 *   look-oracle  solver onto the photographer's real look (ceiling of the forward model)
 *
 * Read `look` (mean code values off the photographer's real result) and `tail`
 * (the same on the fifth of frames that needed the most correction). Both are
 * measured through `develop/look/tone.ts`, the same forward model the solver
 * optimises, so the look-* rows are flattered by it; the slider MAE columns are
 * the check that does not share that bias.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { COLOR_FEATURE_NAMES } from '@shoots/imaging';
import { solveTone } from '../../packages/cli/src/develop/look/solve.js';
import {
  lookDistance,
  lookOf,
  lumaHistogram,
  NEUTRAL_TONE,
  TONE_KEYS,
  toneFromDevelop,
  toneToDevelop,
  type LumaHistogram,
  type Tone,
} from '../../packages/cli/src/develop/look/tone.js';
import { decode } from '../../packages/cli/src/develop/review/preview.js';
import { wbGains } from '../../packages/cli/src/develop/review/color.js';
import { fitRidge, foldsByGroup, mean, sd } from '../lib/fit.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};
const DATA = arg('data', 'train_v2.jsonl');
const CACHE = arg('cache', 'look-hist.json');
const FOLDS = Number(arg('folds', '5'));
const LAMBDA = Number(arg('lambda', '10'));
const STIFFNESS = Number(arg('stiffness', '4'));
const HYBRID = Number(arg('hybrid', '25'));

interface Row {
  file: string;
  session: string;
  develop: Record<string, number>;
  features: number[];
  asShot: { tempAsShot?: number | null; tintAsShot?: number | null };
}

const rows: Row[] = readFileSync(DATA, 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l))
  .filter((r) => r.edited && r.treatment === 'color' && r.develop && r.features)
  .map((r) => ({ ...r, session: path.dirname(r.file) }));
console.log(`${rows.length} edited colour frames, ${new Set(rows.map((r) => r.session)).size} shoots`);

/** The photographer's white balance, applied before tone, as the review does. */
function wbOf(r: Row): [number, number, number] {
  const asShot = r.asShot.tempAsShot && r.asShot.tempAsShot > 0 ? r.asShot.tempAsShot : 5500;
  const chosen = r.develop.Temperature && r.develop.Temperature > 0 ? r.develop.Temperature : asShot;
  const tint = r.asShot.tintAsShot ?? 0;
  return wbGains(asShot, chosen, tint, r.develop.Tint ?? tint);
}

// One RAW decode per frame, ever: the histograms are cached by file.
type Cached = { counts: number[]; anchor: number };
const cache: Record<string, Cached> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
const todo = rows.filter((r) => !cache[r.file]);
if (todo.length) {
  console.log(`decoding ${todo.length} RAWs…`);
  let done = 0;
  const worker = async (): Promise<void> => {
    for (let r = todo.pop(); r; r = todo.pop()) {
      try {
        const h = lumaHistogram(await decode(r.file, 400), wbOf(r));
        cache[r.file] = { counts: Array.from(h.counts, (v) => +v.toFixed(6)), anchor: h.anchor };
      } catch (e) {
        console.warn(`skip ${r.file}: ${(e as Error).message}`);
      }
      if (++done % 25 === 0) {
        console.log(`  ${done}`);
        writeFileSync(CACHE, JSON.stringify(cache));
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  writeFileSync(CACHE, JSON.stringify(cache));
}

const usable = rows.filter((r) => cache[r.file]);
const hist = (r: Row): LumaHistogram => ({ counts: Float64Array.from(cache[r.file]!.counts), anchor: cache[r.file]!.anchor });

/** Scene description: the unedited look, the white, and the colour features the predictor already uses. */
function scene(r: Row): number[] {
  const h = hist(r);
  return [...lookOf(h, NEUTRAL_TONE), h.anchor, ...r.features];
}

const truthTone = (r: Row): Tone => toneFromDevelop(r.develop);
const KEYS = Object.keys(NEUTRAL_TONE) as (keyof Tone)[];
const meanTone = (ts: Tone[]): Tone => Object.fromEntries(KEYS.map((k) => [k, mean(ts.map((t) => t[k]))])) as unknown as Tone;

const VARIANTS = ['neutral', 'preset', 'slider-ridge', 'look-const', 'look-scene', 'hybrid', 'look-oracle'] as const;
type Variant = (typeof VARIANTS)[number];
const predicted: Record<Variant, Map<Row, Tone>> = Object.fromEntries(VARIANTS.map((v) => [v, new Map()])) as never;

const folds = foldsByGroup(usable.map((r) => r.session), FOLDS, 7);
for (let f = 0; f < FOLDS; f++) {
  const train = usable.filter((r) => folds.get(r.session) !== f);
  const test = usable.filter((r) => folds.get(r.session) === f);
  if (!test.length) continue;
  const Xtr = train.map(scene);
  const prior = meanTone(train.map(truthTone));
  const looks = train.map((r) => lookOf(hist(r), truthTone(r)));
  const meanLook = looks[0]!.map((_, i) => mean(looks.map((l) => l[i]!)));
  const sliderFits = KEYS.map((k) => fitRidge(Xtr, train.map((r) => truthTone(r)[k]), LAMBDA));
  const lookFits = meanLook.map((_, i) => fitRidge(Xtr, looks.map((l) => l[i]!), LAMBDA));
  for (const r of test) {
    const h = hist(r);
    const x = scene(r);
    predicted.neutral.set(r, NEUTRAL_TONE);
    predicted.preset.set(r, prior);
    predicted['slider-ridge'].set(r, Object.fromEntries(KEYS.map((k, i) => [k, sliderFits[i]!.predict(x)])) as unknown as Tone);
    // Percentiles must stay ordered or the solver chases an impossible look.
    const sceneLook = lookFits.map((m) => m.predict(x));
    for (let i = 1; i < sceneLook.length; i++) sceneLook[i] = Math.max(sceneLook[i]!, sceneLook[i - 1]!);
    const opts = { prior, stiffness: STIFFNESS };
    predicted['look-const'].set(r, solveTone(h, meanLook, opts));
    predicted['look-scene'].set(r, solveTone(h, sceneLook, opts));
    predicted['look-oracle'].set(r, solveTone(h, lookOf(h, truthTone(r)), opts));
    // Slider regression as the prior: the look only moves what the scene demands.
    predicted.hybrid.set(r, solveTone(h, sceneLook, { prior: predicted['slider-ridge'].get(r)!, stiffness: STIFFNESS * HYBRID }));
  }
  console.log(`fold ${f + 1}/${FOLDS}: ${test.length} frames`);
}

// The tail: frames whose unedited look is furthest from the photographer's result.
const need = new Map(usable.map((r) => [r, lookDistance(lookOf(hist(r), NEUTRAL_TONE), lookOf(hist(r), truthTone(r)))]));
const cut = [...need.values()].sort((a, b) => b - a)[Math.floor(usable.length / 5)]!;
const tail = usable.filter((r) => need.get(r)! >= cut);

/** Mean over shoots of the within-shoot sd of a slider: does it move frame to frame? */
function withinSd(get: (r: Row) => number): number {
  const by = new Map<string, number[]>();
  for (const r of usable) by.set(r.session, [...(by.get(r.session) ?? []), get(r)]);
  return mean([...by.values()].filter((v) => v.length > 2).map((v) => sd(v)));
}

const fmt = (v: number, w = 7, d = 1): string => v.toFixed(d).padStart(w);
console.log(`\nlook = mean |Δ| over 9 display percentiles, 8-bit code values; tail = worst ${tail.length} frames`);
console.log(`slider MAE in Camera Raw units (Exposure in EV); spread = within-shoot sd of Exposure / Highlights / Shadows`);
console.log(`${'variant'.padEnd(13)}${'look'.padStart(7)}${'tail'.padStart(7)}  ${TONE_KEYS.map((k) => k.replace('2012', '').slice(0, 6).padStart(7)).join('')}   spread`);
const truthSpread = ['exposure', 'highlights', 'shadows'].map((k) => withinSd((r) => toneToDevelop(truthTone(r))[TONE_KEYS[KEYS.indexOf(k as keyof Tone)]!]));
for (const v of VARIANTS) {
  const m = predicted[v];
  const look = mean(usable.map((r) => lookDistance(lookOf(hist(r), m.get(r)!), lookOf(hist(r), truthTone(r)))));
  const tl = mean(tail.map((r) => lookDistance(lookOf(hist(r), m.get(r)!), lookOf(hist(r), truthTone(r)))));
  const mae = TONE_KEYS.map((k) => mean(usable.map((r) => Math.abs(toneToDevelop(m.get(r)!)[k] - (r.develop[k] ?? 0)))));
  const spread = ['exposure', 'highlights', 'shadows'].map((k) => withinSd((r) => toneToDevelop(m.get(r)!)[TONE_KEYS[KEYS.indexOf(k as keyof Tone)]!]));
  console.log(`${v.padEnd(13)}${fmt(look)}${fmt(tl)}  ${mae.map((x, i) => fmt(x, 7, i === 0 ? 2 : 1)).join('')}   ${spread.map((x, i) => x.toFixed(i === 0 ? 2 : 1)).join(' / ')}`);
}
console.log(`${'photographer'.padEnd(13)}${fmt(0)}${fmt(0)}  ${' '.repeat(42)}   ${truthSpread.map((x, i) => x.toFixed(i === 0 ? 2 : 1)).join(' / ')}`);
