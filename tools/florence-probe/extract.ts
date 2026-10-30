/**
 * Florence-2 readings for every edited colour frame, cached and resumable.
 *
 *   bun tools/florence-probe/extract.ts --data train_v2.jsonl --out florence-cache.json
 *
 * Per frame: a detailed caption, one grounding call for every phrase at once,
 * and masks only for the regions grounding found (Florence draws a mask for any
 * phrase, present or not). Each region gets its brightness from the same upright
 * preview the model saw. The cache is written every few frames, so a stopped
 * run picks up where it left off.
 *
 * Vision tower and encoder run on DirectML where available; the merged decoder
 * returns only padding there, so it stays on the CPU.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { closeExiftoolDaemon } from '@shoots/imaging';
import { loadFlorence, loadUpright, rasterise, type DeviceMap } from './florence.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};
const OUT = arg('out', 'florence-cache.json');
export const PHRASES = ['sky', 'person', 'face', 'trees', 'water', 'building'] as const;
/** Regions worth a real mask; the rest keep their grounding box. */
const MASKED = ['sky', 'person'] as const;

export interface FlorenceFrame {
  caption: string;
  /** Per phrase: share of the frame it covers (mask where taken, else box), 0 when absent. */
  share: Record<string, number>;
  /** Per phrase: mean, p05, p95, clipped, crushed luma inside it; zeros when absent. */
  luma: Record<string, number[]>;
  /** The same five for whatever is neither sky nor person. */
  rest: number[];
}

function stats(values: number[]): number[] {
  if (!values.length) return [0, 0, 0, 0, 0];
  const s = values.slice().sort((a, b) => a - b);
  const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  const m = s.reduce((a, b) => a + b, 0) / s.length;
  return [m, q(0.05), q(0.95), s.filter((v) => v >= 250 / 255).length / s.length, s.filter((v) => v <= 5 / 255).length / s.length];
}

if (import.meta.main) {
  const files = [
    ...new Set(
      readFileSync(arg('data', 'train_v2.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .filter((r) => r.edited && r.treatment === 'color')
        .map((r) => r.file as string),
    ),
  ];
  const cache: Record<string, FlorenceFrame> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
  const todo = files.filter((f) => !cache[f]);
  const device: DeviceMap = { vision_encoder: 'dml', encoder_model: 'dml', embed_tokens: 'cpu', decoder_model_merged: 'cpu' };
  let fl;
  try {
    fl = await loadFlorence('fp32', device);
  } catch {
    // No DirectML on this machine: everything on the CPU.
    fl = await loadFlorence('fp32', 'cpu');
  }
  console.log(`${todo.length} of ${files.length} frames to read`);
  const started = performance.now();
  let done = 0;
  for (const file of todo) {
    try {
      const { image, jpeg } = await loadUpright(file);
      const { data, info } = await sharp(jpeg).resize(256, 256, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const W = info.width;
      const H = info.height;
      const luma = Array.from({ length: W * H }, (_, i) => (0.2126 * data[i * 3]! + 0.7152 * data[i * 3 + 1]! + 0.0722 * data[i * 3 + 2]!) / 255);

      const caption = await fl.caption(image);
      const g = await fl.ground(image, [...PHRASES]);
      const masks: Record<string, Uint8Array> = {};
      for (const p of PHRASES) {
        const boxes = g.bboxes.filter((_, i) => g.labels[i] === p);
        if (!boxes.length) continue;
        if ((MASKED as readonly string[]).includes(p)) {
          masks[p] = rasterise(await fl.segment(image, `the ${p}`), image.width, image.height, W, H);
        } else {
          // Union of the grounding boxes, on the luma grid.
          const m = new Uint8Array(W * H);
          for (const [x0, y0, x1, y1] of boxes) {
            for (let y = Math.floor((y0! / image.height) * H); y < Math.ceil((y1! / image.height) * H); y++) {
              for (let x = Math.floor((x0! / image.width) * W); x < Math.ceil((x1! / image.width) * W); x++) m[y * W + x] = 1;
            }
          }
          masks[p] = m;
        }
      }
      const share: Record<string, number> = {};
      const lumaBy: Record<string, number[]> = {};
      for (const p of PHRASES) {
        const m = masks[p];
        const inside = m ? luma.filter((_, i) => m[i]) : [];
        share[p] = inside.length / luma.length;
        lumaBy[p] = stats(inside);
      }
      const rest = stats(luma.filter((_, i) => !masks.sky?.[i] && !masks.person?.[i]));
      cache[file] = { caption, share, luma: lumaBy, rest };
    } catch (e) {
      console.warn(`skip ${file}: ${(e as Error).message.slice(0, 120)}`);
    }
    if (++done % 10 === 0 || done === todo.length) {
      writeFileSync(OUT, JSON.stringify(cache));
      const per = (performance.now() - started) / done / 1000;
      console.log(`${done}/${todo.length}  ${per.toFixed(1)}s/frame  ~${Math.round(((todo.length - done) * per) / 60)} min left`);
    }
  }
  writeFileSync(OUT, JSON.stringify(cache));
  await closeExiftoolDaemon();
}
