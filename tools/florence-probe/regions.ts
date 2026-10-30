/**
 * florence regions — do Florence-2's regions and captions predict the
 * photographer's tone moves better than the histogram and CLIP?
 *
 *   bun tools/florence-probe/regions.ts --data train_v2.jsonl --cache look-hist.json --florence florence-cache.json
 *
 * Same held-out protocol as region-probe (whole shoots out, λ chosen inside each
 * training fold, full n and n = 40), with three Florence blocks:
 *
 *   where   which of sky / person / face / trees / water / building is present,
 *           how much of the frame each covers, and how bright it is
 *   caption the detailed caption, embedded with CLIP's text tower and read
 *           against the same light-and-mood vocabulary as the image readings
 *   both
 *
 * and prints which readings move each slider.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { lookOf, NEUTRAL_TONE, TONE_KEYS, type LumaHistogram } from '../../packages/cli/src/develop/look/tone.js';
import { embedTexts, readings, textEmbeddings } from '../lib/clipText.js';
import { fitRidgeCV, foldsByGroup, mean, shuffled } from '../lib/fit.js';
import { PHRASES, type FlorenceFrame } from './extract.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};
const DATA = arg('data', 'train_v2.jsonl');
const CACHE = arg('cache', 'look-hist.json');
const FLORENCE = arg('florence', 'florence-cache.json');
const FOLDS = 5;
const COLD_N = 40;
const COLD_REPEATS = 5;

const SCENES: Record<string, string> = {
  backlit: 'a subject backlit against a bright sky',
  harshSun: 'harsh midday sunlight with hard shadows',
  overcast: 'soft overcast light',
  goldenHour: 'warm golden hour light',
  blueHour: 'blue hour twilight',
  dimIndoor: 'a dim interior with artificial light',
  night: 'a night scene with street lights',
  fog: 'a foggy misty atmosphere',
  openShade: 'a person in open shade',
  lowKey: 'a dark moody low key photograph',
  highKey: 'a bright airy high key photograph',
  landscape: 'a landscape',
  portrait: 'a portrait of a person',
  interior: 'an interior room',
};

interface Row {
  file: string;
  session: string;
  develop: Record<string, number>;
  features: number[];
  embedding: number[];
}

for (const f of [CACHE, FLORENCE]) if (!existsSync(f)) throw new Error(`missing ${f}`);
const hcache: Record<string, { counts: number[]; anchor: number }> = JSON.parse(readFileSync(CACHE, 'utf8'));
const fcache: Record<string, FlorenceFrame> = JSON.parse(readFileSync(FLORENCE, 'utf8'));
const rows: Row[] = readFileSync(DATA, 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l))
  .filter((r) => r.edited && r.treatment === 'color' && r.develop && r.features && r.embedding && hcache[r.file] && fcache[r.file])
  .map((r) => ({ ...r, session: path.dirname(r.file) }));

const DIR = path.dirname(CACHE);
const sceneText = await textEmbeddings(SCENES, path.join(DIR, 'region-scene-text.json'));
const captionVec = new Map<string, number[]>();
const caps = await embedTexts(rows.map((r) => fcache[r.file]!.caption));
rows.forEach((r, i) => captionVec.set(r.file, caps[i]!));

const memo = <T>(fn: (r: Row) => T): ((r: Row) => T) => {
  const m = new Map<Row, T>();
  return (r) => (m.has(r) ? m.get(r)! : (m.set(r, fn(r)), m.get(r)!));
};
const hist = (r: Row): LumaHistogram => ({ counts: Float64Array.from(hcache[r.file]!.counts), anchor: hcache[r.file]!.anchor });
const histogram = memo((r) => [...lookOf(hist(r), NEUTRAL_TONE), hist(r).anchor, ...r.features]);
const scene = memo((r) => readings(r.embedding, sceneText));
const where = memo((r) => {
  const f = fcache[r.file]!;
  return [
    ...PHRASES.flatMap((p) => [f.share[p]! > 0 ? 1 : 0, f.share[p]!, ...f.luma[p]!]),
    ...f.rest,
    // The two contrasts a photographer reads first: subject against the rest, sky against the rest.
    f.share.person! > 0 ? f.luma.person![0]! - f.rest[0]! : 0,
    f.share.sky! > 0 ? f.luma.sky![0]! - f.rest[0]! : 0,
  ];
});
const caption = memo((r) => readings(captionVec.get(r.file)!, sceneText));
const WHERE_NAMES = [
  ...PHRASES.flatMap((p) => ['', 'Share', 'Mean', 'P05', 'P95', 'Clip', 'Crush'].map((s) => `${p}${s || '?'}`)),
  ...['Mean', 'P05', 'P95', 'Clip', 'Crush'].map((s) => `rest${s}`),
  'personVsRest',
  'skyVsRest',
];

const SETS: Record<string, ((r: Row) => number[]) | null> = {
  'preset (mean)': null,
  histogram,
  'hist + scene': (r) => [...histogram(r), ...scene(r)],
  'hist + where': (r) => [...histogram(r), ...where(r)],
  'hist + caption': (r) => [...histogram(r), ...caption(r)],
  'hist + where + caption': (r) => [...histogram(r), ...where(r), ...caption(r)],
  'all semantic': (r) => [...histogram(r), ...scene(r), ...where(r), ...caption(r)],
};

const P = TONE_KEYS.length;
const truth = (r: Row): number[] => TONE_KEYS.map((k) => r.develop[k] ?? 0);

function evaluate(feats: ((r: Row) => number[]) | null, subsample: number | null, seed: number): number[] {
  const folds = foldsByGroup(rows.map((r) => r.session), FOLDS, 7);
  const err = Array.from({ length: P }, () => [] as number[]);
  for (let k = 0; k < FOLDS; k++) {
    let train = rows.filter((r) => folds.get(r.session) !== k);
    const test = rows.filter((r) => folds.get(r.session) === k);
    if (subsample) train = shuffled(train, seed + k).slice(0, subsample);
    for (let i = 0; i < P; i++) {
      const y = train.map((r) => truth(r)[i]!);
      if (!feats) {
        const m = mean(y);
        for (const r of test) err[i]!.push(Math.abs(m - truth(r)[i]!));
        continue;
      }
      const m = fitRidgeCV(train.map(feats), y, train.map((r) => r.session));
      for (const r of test) err[i]!.push(Math.abs(m.predict(feats(r)) - truth(r)[i]!));
    }
  }
  return err.map(mean);
}

const f = (v: number, w: number, d: number): string => v.toFixed(d).padStart(w);
console.log(`${rows.length} frames, ${new Set(rows.map((r) => r.session)).size} shoots`);
const found = (p: string): number => rows.filter((r) => fcache[r.file]!.share[p]! > 0).length;
console.log(`found: ${PHRASES.map((p) => `${p} ${found(p)}`).join(', ')}\n`);
for (const [title, n] of [
  ['held-out MAE, all training frames', null],
  [`cold start: ${COLD_N} training frames, mean of ${COLD_REPEATS} draws`, COLD_N],
] as const) {
  console.log(`${title} (Camera Raw units, Exposure in EV)`);
  console.log(`${'input'.padEnd(24)}${TONE_KEYS.map((k) => k.replace('2012', '').slice(0, 7).padStart(9)).join('')}`);
  for (const [name, feats] of Object.entries(SETS)) {
    const runs = n ? Array.from({ length: COLD_REPEATS }, (_, s) => evaluate(feats, n, 100 + s * 13)) : [evaluate(feats, null, 0)];
    const mae = Array.from({ length: P }, (_, i) => mean(runs.map((r) => r[i]!)));
    console.log(`${name.padEnd(24)}${mae.map((v, i) => f(v, 9, i ? 1 : 2)).join('')}`);
  }
  console.log('');
}

console.log('why — slider change per 1 sd of a reading (fit on where + caption, all frames)');
const names = [...WHERE_NAMES, ...Object.keys(SCENES).map((s) => `caption:${s}`)];
const whyFeats = (r: Row): number[] => [...where(r), ...caption(r)];
for (let i = 0; i < P; i++) {
  const m = fitRidgeCV(rows.map(whyFeats), rows.map((r) => truth(r)[i]!), rows.map((r) => r.session));
  const effect = m.coef.map((c, j) => [names[j]!, c * m.yspread] as const).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const d = i ? 0 : 2;
  console.log(`${TONE_KEYS[i]!.replace('2012', '').padEnd(11)} ${effect.slice(0, 5).map(([n, v]) => `${n} ${v >= 0 ? '+' : ''}${v.toFixed(d)}`).join(', ')}`);
}
