/**
 * keyword-compare — CLIP zero-shot keywords (what `rate` writes today) beside
 * keywords from the Florence-2 vision pass, on one frame per shoot.
 *
 *   bun tools/keyword-compare/index.ts --data train_v2.jsonl --n 20 --out <dir>
 *
 * Writes contact sheets (preview + both keyword lists per frame) to judge by
 * eye, and keywords.json with both lists per file. There is no keyword ground
 * truth in the reference catalog, so the judgement is a person counting wrong
 * words on the sheets.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { closeExiftoolDaemon, loadRenderableImage, readOrientation } from '@shoots/imaging';
import { clipModelManifest } from '../../packages/inference/src/models/clipManifest.js';
import { loadKeywordVocab, matchKeywords } from '../../packages/inference/src/models/keywords.js';
import { readVision } from '../../packages/cli/src/vision/read.js';
import { keywordsFromVision } from '../../packages/cli/src/vision/keywords.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};
const N = Number(arg('n', '20'));
const OUT = arg('out', 'keyword-compare');
mkdirSync(OUT, { recursive: true });

// One edited frame per shoot, from the middle of the shoot rather than its first test shots.
const byShoot = new Map<string, { file: string; embedding: number[] }[]>();
for (const l of readFileSync(arg('data', 'train_v2.jsonl'), 'utf8').trim().split('\n')) {
  const r = JSON.parse(l);
  if (!r.edited || !r.embedding) continue;
  const k = path.dirname(r.file);
  byShoot.set(k, [...(byShoot.get(k) ?? []), r]);
}
// --at picks where in each shoot to take the frame (0.5 = the middle), so a second sample never repeats the first.
const AT = Number(arg('at', '0.5'));
const sample = [...byShoot.values()].map((q) => q[Math.min(q.length - 1, Math.floor(q.length * AT))]!).slice(-N);

// CLIP as `rate` runs it: top 6 over a 0.2 floor (LocalOnnxModel).
const vocab = await loadKeywordVocab(clipModelManifest().vocabPath);
const clip = new Map(sample.map((r) => [r.file, matchKeywords(vocab, Float32Array.from(r.embedding), 6, 0.2)]));
const vision = await readVision(sample.map((r) => r.file), (m) => process.stderr.write(`${m}\n`));
const florence = new Map(sample.map((r) => [r.file, vision.has(r.file) ? keywordsFromVision(vision.get(r.file)!) : []]));
writeFileSync(
  path.join(OUT, 'keywords.json'),
  JSON.stringify(sample.map((r) => ({ file: r.file, clip: clip.get(r.file), florence: florence.get(r.file), caption: vision.get(r.file)?.caption })), null, 2),
);

const W = 520;
const IMG_H = 300;
const TEXT_H = 64;
const esc = (s: string): string => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
async function tile(file: string, index: number): Promise<Buffer> {
  const { buffer } = await loadRenderableImage(file);
  const rot = ({ 3: 180, 6: 90, 8: 270 } as Record<number, number>)[await readOrientation(file)] ?? 0;
  const img = await sharp(buffer).rotate(rot).resize(W, IMG_H, { fit: 'contain', background: '#222' }).toBuffer();
  const svg = `<svg width="${W}" height="${TEXT_H}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/>
    <text x="8" y="20" font-family="Arial" font-size="15" fill="#ffd27a">#${index} CLIP: ${esc((clip.get(file) ?? []).join(', '))}</text>
    <text x="8" y="44" font-family="Arial" font-size="15" fill="#9fe39f">FLO: ${esc((florence.get(file) ?? []).join(', '))}</text></svg>`;
  return sharp({ create: { width: W, height: IMG_H + TEXT_H, channels: 3, background: '#111' } })
    .composite([{ input: img, top: 0, left: 0 }, { input: Buffer.from(svg), top: IMG_H, left: 0 }])
    .png()
    .toBuffer();
}

const PER_SHEET = 4;
for (let s = 0; s * PER_SHEET < sample.length; s++) {
  const part = sample.slice(s * PER_SHEET, (s + 1) * PER_SHEET);
  const tiles = await Promise.all(part.map((r, i) => tile(r.file, s * PER_SHEET + i + 1)));
  const cols = 2;
  const rows = Math.ceil(tiles.length / cols);
  await sharp({ create: { width: W * cols, height: (IMG_H + TEXT_H) * rows, channels: 3, background: '#000' } })
    .composite(tiles.map((t, i) => ({ input: t, left: (i % cols) * W, top: Math.floor(i / cols) * (IMG_H + TEXT_H) })))
    .jpeg({ quality: 85 })
    .toFile(path.join(OUT, `sheet-${s + 1}.jpg`));
}
await closeExiftoolDaemon();
process.stderr.write(`wrote ${Math.ceil(sample.length / PER_SHEET)} sheets and keywords.json to ${OUT}\n`);
