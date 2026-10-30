/**
 * semantic-probe — does reading the *scene* (light, mood, subject) predict the
 * photographer's tone moves better than measuring the histogram, and does it
 * say why?
 *
 *   bun tools/semantic-probe/index.ts --data train_v2.jsonl --cache look-hist.json
 *
 * A photographer looks at the scene before touching a slider: backlight, open
 * shade, a moody interior. The histogram only says where the pixels are. This
 * tool scores every frame against a vocabulary of scene descriptions with CLIP
 * (zero-shot: cosine between the stored image embedding and the embedded text),
 * then compares held-out prediction from the histogram, from the scene scores,
 * and from both, at full n and at n = 40.
 *
 * The scores are linear in the embedding, so they cannot know more than the raw
 * 512 dimensions; what they add is a small, named bottleneck — fewer things to
 * fit at cold start, and coefficients a photographer can read.
 *
 * Text embeddings come from the same CLIP text tower `scripts/prepare-model-mirror.ts`
 * uses, computed once and cached next to the histogram cache.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AutoTokenizer, CLIPTextModelWithProjection } from '@huggingface/transformers';
import { lookOf, NEUTRAL_TONE, TONE_KEYS, type LumaHistogram } from '../../packages/cli/src/develop/look/tone.js';
import { fitRidgeCV, foldsByGroup, mean, shuffled } from '../lib/fit.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};
const DATA = arg('data', 'train_v2.jsonl');
const CACHE = arg('cache', 'look-hist.json');
const TEXT_CACHE = path.join(path.dirname(CACHE), 'scene-text.json');
const FOLDS = 5;
const COLD_N = 40;
const COLD_REPEATS = 5;

/** What a photographer reads in a scene before deciding on tone. */
const SCENES: Record<string, string> = {
  backlit: 'a subject backlit against a bright sky',
  silhouette: 'a silhouette against the light',
  harshSun: 'harsh midday sunlight with hard shadows',
  overcast: 'soft overcast light',
  goldenHour: 'warm golden hour light',
  blueHour: 'blue hour twilight',
  window: 'soft window light indoors',
  dimIndoor: 'a dim interior with artificial light',
  night: 'a night scene with street lights',
  fog: 'a foggy misty atmosphere',
  dappled: 'dappled light through trees',
  openShade: 'a person in open shade',
  flash: 'a photo taken with direct flash',
  lowKey: 'a dark moody low key photograph',
  highKey: 'a bright airy high key photograph',
  hardContrast: 'a high contrast scene',
  flat: 'a flat low contrast scene',
  skyDarkGround: 'a bright sky above a dark foreground',
  portrait: 'a portrait of a person',
  face: 'a close-up of a face',
  group: 'a group of people',
  landscape: 'a landscape',
  city: 'a cityscape',
  interior: 'an interior room',
  beach: 'a beach',
  snow: 'snow',
  wedding: 'a wedding',
  street: 'a street scene',
};
const NAMES = Object.keys(SCENES);

async function textEmbeddings(): Promise<number[][]> {
  if (existsSync(TEXT_CACHE)) {
    const cached = JSON.parse(readFileSync(TEXT_CACHE, 'utf8'));
    if (JSON.stringify(cached.prompts) === JSON.stringify(SCENES)) return cached.embeddings;
  }
  const id = 'Xenova/clip-vit-base-patch32';
  const tokenizer = await AutoTokenizer.from_pretrained(id);
  const model = await CLIPTextModelWithProjection.from_pretrained(id, { dtype: 'int8' });
  const prompts = NAMES.map((n) => `a photo of ${SCENES[n]}`);
  const { text_embeds } = (await model(tokenizer(prompts, { padding: true, truncation: true }))) as {
    text_embeds: { data: ArrayLike<number>; dims: number[] };
  };
  const dim = text_embeds.dims[1]!;
  const data = Array.from(text_embeds.data);
  const embeddings = prompts.map((_, i) => data.slice(i * dim, (i + 1) * dim));
  writeFileSync(TEXT_CACHE, JSON.stringify({ prompts: SCENES, embeddings }));
  return embeddings;
}

const unit = (v: number[]): number[] => {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};

interface Row {
  file: string;
  session: string;
  develop: Record<string, number>;
  features: number[];
  embedding: number[];
}

if (!existsSync(CACHE)) throw new Error(`no histogram cache at ${CACHE} — run tools/look-probe first`);
const cache: Record<string, { counts: number[]; anchor: number }> = JSON.parse(readFileSync(CACHE, 'utf8'));
const rows: Row[] = readFileSync(DATA, 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l))
  .filter((r) => r.edited && r.treatment === 'color' && r.develop && r.features && r.embedding && cache[r.file])
  .map((r) => ({ ...r, session: path.dirname(r.file) }));
const hist = (r: Row): LumaHistogram => ({ counts: Float64Array.from(cache[r.file]!.counts), anchor: cache[r.file]!.anchor });

const text = (await textEmbeddings()).map(unit);
const scoreCache = new Map<Row, number[]>();
const scene = (r: Row): number[] => {
  let s = scoreCache.get(r);
  if (!s) {
    const e = unit(r.embedding);
    s = text.map((t) => 100 * t.reduce((a, v, i) => a + v * e[i]!, 0));
    scoreCache.set(r, s);
  }
  return s;
};
const histogram = (r: Row): number[] => [...lookOf(hist(r), NEUTRAL_TONE), hist(r).anchor, ...r.features];

const SETS: Record<string, ((r: Row) => number[]) | null> = {
  'preset (mean)': null,
  histogram,
  scene,
  'histogram + scene': (r) => [...histogram(r), ...scene(r)],
  'histogram + raw CLIP': (r) => [...histogram(r), ...r.embedding],
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
console.log(`${rows.length} frames, ${new Set(rows.map((r) => r.session)).size} shoots, ${NAMES.length} scene descriptions\n`);
for (const [title, n] of [
  ['held-out MAE, all training frames', null],
  [`cold start: ${COLD_N} training frames, mean of ${COLD_REPEATS} draws`, COLD_N],
] as const) {
  console.log(`${title} (Camera Raw units, Exposure in EV)`);
  console.log(`${'input'.padEnd(22)}${TONE_KEYS.map((k) => k.replace('2012', '').slice(0, 7).padStart(9)).join('')}`);
  for (const [name, feats] of Object.entries(SETS)) {
    const runs = n ? Array.from({ length: COLD_REPEATS }, (_, s) => evaluate(feats, n, 100 + s * 13)) : [evaluate(feats, null, 0)];
    const mae = Array.from({ length: P }, (_, i) => mean(runs.map((r) => r[i]!)));
    console.log(`${name.padEnd(22)}${mae.map((v, i) => f(v, 9, i ? 1 : 2)).join('')}`);
  }
  console.log('');
}

// Why: on all frames, the scene readings that move each slider most, per sd of the reading.
console.log('why — slider change per 1 sd of a scene reading (fit on scene alone, all frames)');
for (let i = 0; i < P; i++) {
  const m = fitRidgeCV(rows.map(scene), rows.map((r) => truth(r)[i]!), rows.map((r) => r.session));
  const effect = m.coef.map((c, j) => [NAMES[j]!, c * m.yspread] as const).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const d = i ? 0 : 2;
  console.log(`${TONE_KEYS[i]!.replace('2012', '').padEnd(11)} ${effect.slice(0, 4).map(([n, v]) => `${n} ${v >= 0 ? '+' : ''}${v.toFixed(d)}`).join(', ')}`);
}
