/**
 * Does a quantised Florence-2 see the same things as fp32, and how much faster?
 *
 *   bun tools/florence-probe/bench.ts --data train_v2.jsonl [--n 8]
 *
 * One edited frame per shoot (up to n), the same three questions to every
 * variant: a detailed caption, grounding of "sky. person. face.", and masks for
 * the sky and the person when grounding found them. fp32 is the reference;
 * the quantised variants are scored on agreement with it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { closeExiftoolDaemon } from '@shoots/imaging';
import type { RawImage } from '@huggingface/transformers';
import { loadFlorence, loadUpright, rasterise, type Device, type Dtype, type Florence } from './florence.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};
const N = Number(arg('n', '8'));
const PHRASES = ['sky', 'person', 'face'];
/** dtype@device; the first is the reference. */
const VARIANTS = arg('variants', 'fp32@cpu,q8@cpu,q4@cpu,fp32@dml').split(',');

const seen = new Set<string>();
const files: string[] = [];
for (const l of readFileSync(arg('data', 'train_v2.jsonl'), 'utf8').trim().split('\n')) {
  const r = JSON.parse(l);
  if (!r.edited || seen.has(path.dirname(r.file))) continue;
  seen.add(path.dirname(r.file));
  files.push(r.file);
}
const sample = files.filter((_, i) => i % Math.max(1, Math.floor(files.length / N)) === 0).slice(0, N);
const images: RawImage[] = [];
for (const f of sample) images.push((await loadUpright(f)).image);
await closeExiftoolDaemon();

interface Answer {
  caption: string;
  labels: string[];
  boxes: Record<string, number[]>;
  masks: Record<string, Uint8Array>;
  ms: { caption: number; ground: number; segment: number };
}

async function ask(fl: Florence, image: RawImage): Promise<Answer> {
  let t = performance.now();
  const caption = await fl.caption(image);
  const ms = { caption: performance.now() - t, ground: 0, segment: 0 };
  t = performance.now();
  const g = await fl.ground(image, PHRASES);
  ms.ground = performance.now() - t;
  const boxes: Record<string, number[]> = {};
  g.labels.forEach((l, i) => (boxes[l] ??= g.bboxes[i]!));
  const masks: Record<string, Uint8Array> = {};
  t = performance.now();
  // Only what grounding found: Florence draws a mask for any phrase.
  for (const p of ['sky', 'person'].filter((p) => boxes[p])) masks[p] = rasterise(await fl.segment(image, `the ${p}`), image.width, image.height);
  ms.segment = performance.now() - t;
  return { caption, labels: [...new Set(g.labels)].sort(), boxes, masks, ms };
}

const words = (s: string): Set<string> => new Set(s.toLowerCase().match(/[a-z]+/g) ?? []);
const jaccard = <T>(a: Set<T>, b: Set<T>): number => {
  const inter = [...a].filter((x) => b.has(x)).length;
  return inter / Math.max(1, a.size + b.size - inter);
};
const boxIou = (a: number[], b: number[]): number => {
  const iw = Math.max(0, Math.min(a[2]!, b[2]!) - Math.max(a[0]!, b[0]!));
  const ih = Math.max(0, Math.min(a[3]!, b[3]!) - Math.max(a[1]!, b[1]!));
  const inter = iw * ih;
  return inter / ((a[2]! - a[0]!) * (a[3]! - a[1]!) + (b[2]! - b[0]!) * (b[3]! - b[1]!) - inter);
};
const maskIou = (a: Uint8Array, b: Uint8Array): number => {
  let i = 0;
  let u = 0;
  for (let k = 0; k < a.length; k++) {
    i += a[k]! & b[k]!;
    u += a[k]! | b[k]!;
  }
  return u ? i / u : 1;
};
const avg = (v: number[]): number => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);

const answers = new Map<string, Answer[]>();
for (const v of VARIANTS) {
  const t = performance.now();
  const [dtype, device] = v.split('@') as [Dtype, Device];
  let fl: Florence;
  try {
    fl = await loadFlorence(dtype, device);
  } catch (e) {
    console.log(`${v} unavailable: ${(e as Error).message.slice(0, 160)}`);
    continue;
  }
  const load = performance.now() - t;
  const out: Answer[] = [];
  for (const img of images) out.push(await ask(fl, img));
  answers.set(v, out);
  const ms = (k: keyof Answer['ms']): string => `${Math.round(avg(out.map((a) => a.ms[k])))}ms`.padStart(8);
  console.log(`${v.padEnd(10)} load ${Math.round(load)}ms  caption ${ms('caption')}  ground ${ms('ground')}  segment ${ms('segment')}`);
}

const ref = answers.get(VARIANTS[0]!)!;
console.log(`\nagreement with fp32 over ${images.length} frames`);
for (const v of VARIANTS.slice(1)) {
  const a = answers.get(v);
  if (!a) continue;
  const cap = avg(a.map((x, i) => jaccard(words(x.caption), words(ref[i]!.caption))));
  const lab = avg(a.map((x, i) => jaccard(new Set(x.labels), new Set(ref[i]!.labels))));
  const box = avg(a.flatMap((x, i) => Object.keys(ref[i]!.boxes).filter((l) => x.boxes[l]).map((l) => boxIou(x.boxes[l]!, ref[i]!.boxes[l]!))));
  const mask = avg(a.flatMap((x, i) => Object.keys(ref[i]!.masks).filter((l) => x.masks[l]).map((l) => maskIou(x.masks[l]!, ref[i]!.masks[l]!))));
  console.log(`${v.padEnd(10)} caption words ${cap.toFixed(2)}  found-labels ${lab.toFixed(2)}  box IoU ${box.toFixed(2)}  mask IoU ${mask.toFixed(2)}`);
}
console.log('\nsample captions (fp32 | q4):');
ref.slice(0, 3).forEach((r, i) => console.log(`- ${r.caption.slice(0, 160)}\n  ${answers.get('q4')![i]!.caption.slice(0, 160)}`));
