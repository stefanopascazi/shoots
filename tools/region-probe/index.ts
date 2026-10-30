/**
 * region-probe — does knowing *what is where* (subject, sky, ground) predict the
 * photographer's tone moves better than reading the frame as a whole?
 *
 *   bun tools/region-probe/index.ts --data train_v2.jsonl --cache look-hist.json
 *
 * "Open the shadows" means something different when the shadow is a face than
 * when it is a hedge. A whole-frame embedding knows there is a person and a sky;
 * it does not know the person is the dark part. Per frame this tool finds:
 *
 *   subject  the in-focus tiles of the focus map (the photographer focused on it)
 *   top      the upper third, where the sky usually is
 *   bottom   the lower third
 *
 * and for each one measures its brightness and reads it with CLIP against a
 * vocabulary of regional content (face, sky, foliage, shadow…). Then it compares
 * held-out prediction from the histogram, the whole-frame scene readings, and
 * each regional block, at full n and at n = 40, and prints which readings move
 * each slider.
 *
 * Pixels are the RAW's embedded preview, turned upright. Region measurements are
 * cached per file next to the histogram cache.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { closeExiftoolDaemon, laplacianVariance, loadRenderableImage, preprocessClip, readOrientation } from '@shoots/imaging';
import { CLIP_INPUT, ensureClipModel } from '../../packages/inference/src/models/clipManifest.js';
import { lookOf, NEUTRAL_TONE, TONE_KEYS, type LumaHistogram } from '../../packages/cli/src/develop/look/tone.js';
import { readings, textEmbeddings } from '../lib/clipText.js';
import { fitRidgeCV, foldsByGroup, mean, shuffled } from '../lib/fit.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};
const DATA = arg('data', 'train_v2.jsonl');
const CACHE = arg('cache', 'look-hist.json');
const DIR = path.dirname(CACHE);
const REGION_CACHE = path.join(DIR, 'region-cache.json');
const FOLDS = 5;
const COLD_N = 40;
const COLD_REPEATS = 5;
/** A tile belongs to the subject when it is at least this sharp relative to the sharpest. */
const SUBJECT_SHARPNESS = 0.5;

/** Whole-frame light and mood, as in semantic-probe. */
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
/** What a region can be. */
const PARTS: Record<string, string> = {
  face: "a person's face",
  person: 'a person',
  skyBlue: 'a clear blue sky',
  skyWhite: 'a white overcast sky',
  skySunset: 'a colourful sunset sky',
  foliage: 'trees and green foliage',
  water: 'water',
  building: 'a building',
  ground: 'the ground or a road',
  darkShadow: 'deep dark shadows',
  brightLight: 'a bright light source',
  fabric: 'clothing and fabric',
};
const REGIONS = ['subject', 'top', 'bottom'] as const;
type Region = (typeof REGIONS)[number];

interface RegionData {
  /** Share of the frame the subject covers; ~1 means nothing stands out. */
  subjectShare: number;
  /** Per region: mean, p05, p95 luma (0..1), clipped and crushed shares. */
  luma: Record<Region | 'background', number[]>;
  /** Per region: CLIP image embedding of its crop. */
  embedding: Record<Region, number[]>;
}

interface Row {
  file: string;
  session: string;
  develop: Record<string, number>;
  features: number[];
  embedding: number[];
}

if (!existsSync(CACHE)) throw new Error(`no histogram cache at ${CACHE} — run tools/look-probe first`);
const hcache: Record<string, { counts: number[]; anchor: number }> = JSON.parse(readFileSync(CACHE, 'utf8'));
const rows: Row[] = readFileSync(DATA, 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l))
  .filter((r) => r.edited && r.treatment === 'color' && r.develop && r.features && r.embedding && hcache[r.file])
  .map((r) => ({ ...r, session: path.dirname(r.file) }));

// ── Region extraction ────────────────────────────────────────────────────────

/** EXIF orientation to a clockwise rotation; mirrored orientations are rare enough to ignore here. */
const ROTATION: Record<number, number> = { 3: 180, 6: 90, 8: 270 };

function lumaStats(values: number[]): number[] {
  if (!values.length) return [0, 0, 0, 0, 0];
  const s = values.slice().sort((a, b) => a - b);
  const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return [mean(s), q(0.05), q(0.95), s.filter((v) => v >= 250 / 255).length / s.length, s.filter((v) => v <= 5 / 255).length / s.length];
}

async function extract(file: string, embed: (jpeg: Buffer) => Promise<number[]>): Promise<RegionData> {
  const { buffer } = await loadRenderableImage(file);
  const rot = ROTATION[await readOrientation(file)] ?? 0;
  const upright = await sharp(buffer).rotate(rot).resize(768, 768, { fit: 'inside' }).jpeg({ quality: 92 }).toBuffer();
  const { focusMap } = await laplacianVariance(upright);
  const { data, info } = await sharp(upright).resize(256, 256, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;

  // Subject mask on the focus grid, then its bounding box for the crop.
  const peak = Math.max(...focusMap.tiles);
  const sharpTile = focusMap.tiles.map((v) => v >= SUBJECT_SHARPNESS * peak);
  let [c0, r0, c1, r1] = [focusMap.cols, focusMap.rows, -1, -1];
  sharpTile.forEach((on, i) => {
    if (!on) return;
    const c = i % focusMap.cols;
    const r = Math.floor(i / focusMap.cols);
    [c0, r0, c1, r1] = [Math.min(c0, c), Math.min(r0, r), Math.max(c1, c), Math.max(r1, r)];
  });
  const inSubject = (x: number, y: number): boolean =>
    sharpTile[Math.min(focusMap.rows - 1, Math.floor((y / H) * focusMap.rows)) * focusMap.cols + Math.min(focusMap.cols - 1, Math.floor((x / W) * focusMap.cols))]!;

  const buckets: Record<Region | 'background', number[]> = { subject: [], background: [], top: [], bottom: [] };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const l = (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255;
      (inSubject(x, y) ? buckets.subject : buckets.background).push(l);
      if (y < H / 3) buckets.top.push(l);
      if (y >= (2 * H) / 3) buckets.bottom.push(l);
    }
  }

  const meta = await sharp(upright).metadata();
  const UW = meta.width!;
  const UH = meta.height!;
  const crop = (left: number, top: number, width: number, height: number): Promise<Buffer> =>
    sharp(upright)
      .extract({ left: Math.round(left), top: Math.round(top), width: Math.max(16, Math.round(width)), height: Math.max(16, Math.round(height)) })
      .jpeg({ quality: 92 })
      .toBuffer();
  const tw = UW / focusMap.cols;
  const th = UH / focusMap.rows;
  const sx = Math.max(0, (c0 - 0.5) * tw);
  const sy = Math.max(0, (r0 - 0.5) * th);
  const subjectCrop = await crop(sx, sy, Math.min(UW - sx, (c1 - c0 + 2) * tw), Math.min(UH - sy, (r1 - r0 + 2) * th));
  return {
    subjectShare: sharpTile.filter(Boolean).length / sharpTile.length,
    luma: {
      subject: lumaStats(buckets.subject),
      background: lumaStats(buckets.background),
      top: lumaStats(buckets.top),
      bottom: lumaStats(buckets.bottom),
    },
    embedding: {
      subject: await embed(subjectCrop),
      top: await embed(await crop(0, 0, UW, UH / 3)),
      bottom: await embed(await crop(0, (2 * UH) / 3, UW, UH / 3)),
    },
  };
}

const rcache: Record<string, RegionData> = existsSync(REGION_CACHE) ? JSON.parse(readFileSync(REGION_CACHE, 'utf8')) : {};
const todo = rows.filter((r) => !rcache[r.file]);
if (todo.length) {
  const ort = await import('onnxruntime-node');
  const manifest = await ensureClipModel();
  const session = await ort.InferenceSession.create(manifest.imageEncoderPath);
  const embed = async (jpeg: Buffer): Promise<number[]> => {
    const pixels = await preprocessClip(jpeg, CLIP_INPUT);
    const out = await session.run({ pixel_values: new ort.Tensor('float32', pixels, [1, 3, CLIP_INPUT.size, CLIP_INPUT.size]) });
    return Array.from(out.image_embeds!.data as Float32Array, (v) => +v.toFixed(5));
  };
  console.log(`measuring regions on ${todo.length} frames…`);
  let done = 0;
  for (const r of todo) {
    try {
      rcache[r.file] = await extract(r.file, embed);
    } catch (e) {
      console.warn(`skip ${r.file}: ${(e as Error).message}`);
    }
    if (++done % 50 === 0) {
      console.log(`  ${done}`);
      writeFileSync(REGION_CACHE, JSON.stringify(rcache));
    }
  }
  writeFileSync(REGION_CACHE, JSON.stringify(rcache));
  // The shared exiftool daemon keeps the event loop alive; without this the run never exits.
  await closeExiftoolDaemon();
}
const usable = rows.filter((r) => rcache[r.file]);

// ── Feature blocks ───────────────────────────────────────────────────────────
const sceneText = await textEmbeddings(SCENES, path.join(DIR, 'region-scene-text.json'));
const partText = await textEmbeddings(PARTS, path.join(DIR, 'region-part-text.json'));
const hist = (r: Row): LumaHistogram => ({ counts: Float64Array.from(hcache[r.file]!.counts), anchor: hcache[r.file]!.anchor });
const memo = <T>(fn: (r: Row) => T): ((r: Row) => T) => {
  const m = new Map<Row, T>();
  return (r) => (m.has(r) ? m.get(r)! : (m.set(r, fn(r)), m.get(r)!));
};

const histogram = memo((r) => [...lookOf(hist(r), NEUTRAL_TONE), hist(r).anchor, ...r.features]);
const scene = memo((r) => readings(r.embedding, sceneText));
/** Where the light is: each region's brightness, and the subject against its surroundings. */
const regionLuma = memo((r) => {
  const d = rcache[r.file]!;
  return [
    d.subjectShare,
    ...d.luma.subject,
    ...d.luma.background,
    ...d.luma.top,
    ...d.luma.bottom,
    d.luma.subject[0]! - d.luma.background[0]!,
    d.luma.top[0]! - d.luma.bottom[0]!,
  ];
});
/** What each region is. */
const regionWhat = memo((r) => REGIONS.flatMap((g) => readings(rcache[r.file]!.embedding[g], partText)));

const REGION_LUMA_NAMES = [
  'subjectShare',
  ...['subject', 'background', 'top', 'bottom'].flatMap((g) => ['Mean', 'P05', 'P95', 'Clip', 'Crush'].map((s) => g + s)),
  'subjectVsBackground',
  'topVsBottom',
];
const REGION_WHAT_NAMES = REGIONS.flatMap((g) => Object.keys(PARTS).map((p) => `${g}:${p}`));

const SETS: Record<string, ((r: Row) => number[]) | null> = {
  'preset (mean)': null,
  histogram,
  'hist + scene': (r) => [...histogram(r), ...scene(r)],
  'hist + where-light': (r) => [...histogram(r), ...regionLuma(r)],
  'hist + where-what': (r) => [...histogram(r), ...regionWhat(r)],
  'hist + scene + where': (r) => [...histogram(r), ...scene(r), ...regionLuma(r), ...regionWhat(r)],
  'scene + where only': (r) => [...scene(r), ...regionLuma(r), ...regionWhat(r)],
};

// ── Evaluation ───────────────────────────────────────────────────────────────
const P = TONE_KEYS.length;
const truth = (r: Row): number[] => TONE_KEYS.map((k) => r.develop[k] ?? 0);

function evaluate(feats: ((r: Row) => number[]) | null, subsample: number | null, seed: number): number[] {
  const folds = foldsByGroup(usable.map((r) => r.session), FOLDS, 7);
  const err = Array.from({ length: P }, () => [] as number[]);
  for (let k = 0; k < FOLDS; k++) {
    let train = usable.filter((r) => folds.get(r.session) !== k);
    const test = usable.filter((r) => folds.get(r.session) === k);
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
console.log(`${usable.length} frames, ${new Set(usable.map((r) => r.session)).size} shoots\n`);
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

console.log('why — slider change per 1 sd of a reading (fit on scene + where, all frames)');
const names = [...Object.keys(SCENES), ...REGION_LUMA_NAMES, ...REGION_WHAT_NAMES];
const whyFeats = SETS['scene + where only']!;
for (let i = 0; i < P; i++) {
  const m = fitRidgeCV(usable.map(whyFeats), usable.map((r) => truth(r)[i]!), usable.map((r) => r.session));
  const effect = m.coef.map((c, j) => [names[j]!, c * m.yspread] as const).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const d = i ? 0 : 2;
  console.log(`${TONE_KEYS[i]!.replace('2012', '').padEnd(11)} ${effect.slice(0, 5).map(([n, v]) => `${n} ${v >= 0 ? '+' : ''}${v.toFixed(d)}`).join(', ')}`);
}
