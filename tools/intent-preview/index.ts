/**
 * intent-preview — a contact sheet of what each develop intent does, to judge by eye.
 *
 *   bun tools/intent-preview/index.ts --data small.jsonl --base base.json \
 *     --variant "Preserve highlights=ph.json" --variant "Open shadows=os.json" --out sheet.html
 *
 * Every input is a `develop predict --out` file over the same dataset: one
 * without intents, one per intent. Frames where some intent moved a slider are
 * picked, spread over shoots, and each is rendered with every variant's tone
 * controls through the review screen's tone model — an approximation of
 * Lightroom, good enough to see whether an intent goes too far, not far
 * enough, or the wrong way. Writes one self-contained HTML page.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { decode } from '../../packages/cli/src/develop/review/preview.js';
import { toWb } from '../../packages/cli/src/develop/review/ramp.js';
import { lookOf, lumaHistogram, renderTone, TONE_KEYS, toneFromDevelop } from '../../packages/cli/src/develop/look/tone.js';
import type { LinearImage } from '../../packages/cli/src/develop/review/color.js';

const args = process.argv.slice(2);
const one = (name: string, fallback?: string): string => {
  const i = args.indexOf(`--${name}`);
  if (i < 0 && fallback === undefined) throw new Error(`--${name} is required`);
  return i >= 0 ? args[i + 1]! : fallback!;
};
const many = (name: string): string[] => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]!] : []));

interface Pred {
  file: string;
  develop: Record<string, number>;
}
const load = (f: string): Map<string, Pred> =>
  new Map((JSON.parse(readFileSync(f, 'utf8')).predictions as Pred[]).map((p) => [p.file, p]));

const base = load(one('base'));
const variants = many('variant').map((v) => {
  const [label, file] = v.split('=');
  return { label: label!, preds: load(file!) };
});
const asShot = new Map<string, Record<string, unknown>>();
for (const l of readFileSync(one('data'), 'utf8').trim().split('\n')) {
  const r = JSON.parse(l);
  if (r.file) asShot.set(r.file, r.asShot);
}
const N = Number(one('n', '8'));

const moved = (a: Pred, b: Pred): [string, number][] =>
  TONE_KEYS.map((k) => [k, (b.develop[k] ?? 0) - (a.develop[k] ?? 0)] as [string, number]).filter(([, d]) => Math.abs(d) > 1e-6);

// Frames some intent changed, one shoot at a time so the sheet spans the catalog.
const candidates = [...base.values()].filter((p) => variants.some((v) => v.preds.has(p.file) && moved(p, v.preds.get(p.file)!).length));
const byShoot = new Map<string, Pred[]>();
for (const p of candidates) byShoot.set(path.dirname(p.file), [...(byShoot.get(path.dirname(p.file)) ?? []), p]);
const picked: Pred[] = [];
for (let round = 0; picked.length < N && [...byShoot.values()].some((q) => q.length > round); round++) {
  for (const q of byShoot.values()) if (q[round] && picked.length < N) picked.push(q[round]!);
}

const label = (k: string): string => k.replace('2012', '');
const fmt = ([k, d]: [string, number]): string =>
  `${label(k)} ${d > 0 ? '+' : '−'}${k === 'Exposure2012' ? Math.abs(d).toFixed(2) : Math.round(Math.abs(d))}`;
const escape = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * A viewing aid, one per row: the exposure offset that puts the prediction's
 * median at a normal screen brightness. The tone model renders far darker than
 * Lightroom (no camera-profile curve), and at that level every variant looks
 * the same. The same offset goes on every column, so the differences between
 * them are the intents' own.
 */
function viewingOffset(img: LinearImage, file: string, develop: Record<string, number>): number {
  const hist = lumaHistogram(img, toWb(develop, asShot.get(file) as never));
  const tone = toneFromDevelop(develop);
  let best = 0;
  let err = Infinity;
  for (let e = -1; e <= 4; e += 0.05) {
    const d = Math.abs(lookOf(hist, { ...tone, exposure: tone.exposure + e })[4]! - 0.45);
    if (d < err) [best, err] = [e, d];
  }
  return best;
}

async function jpeg(img: LinearImage, file: string, develop: Record<string, number>, offset: number): Promise<string> {
  const meta = asShot.get(file) as never;
  const tone = toneFromDevelop(develop);
  const rgb = renderTone(img, toWb(develop, meta), { ...tone, exposure: tone.exposure + offset }, lumaHistogram(img).anchor);
  const buf = await sharp(Buffer.from(rgb), { raw: { width: img.width, height: img.height, channels: 3 } }).jpeg({ quality: 80 }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

const rows: string[] = [];
for (const p of picked) {
  const img0 = await decode(p.file, 720);
  const offset = viewingOffset(img0, p.file, p.develop);
  const cells = [`<figure><img src="${await jpeg(img0, p.file, p.develop, offset)}" alt="Prediction"><figcaption><b>Prediction</b><span>no intent</span></figcaption></figure>`];
  for (const v of variants) {
    const q = v.preds.get(p.file);
    if (!q) continue;
    const m = moved(p, q);
    const img = m.length ? `<img src="${await jpeg(img0, p.file, q.develop, offset)}" alt="${escape(v.label)}">` : '<div class="same">Already met — unchanged</div>';
    cells.push(`<figure>${img}<figcaption><b>${escape(v.label)}</b><span>${m.length ? m.map(fmt).join(' · ') : 'no change'}</span></figcaption></figure>`);
  }
  rows.push(`<section class="frame"><h2>${escape(path.basename(path.dirname(p.file)))} / ${escape(path.basename(p.file))}</h2><div class="strip">${cells.join('')}</div></section>`);
  process.stderr.write(`rendered ${rows.length}/${picked.length}\n`);
}

const page = `<title>Intent Contact Sheet</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Condensed:wght@500;600&family=IBM+Plex+Mono:wght@400&display=swap">
<style>
/* Layout: one row per photograph, its variants side by side on a neutral ground, as on a light table. */
:root {
  --ground: #8a8a8a;      /* neutral mid-grey: the only fair surround for judging tone */
  --panel: #7b7b7b;
  --ink: #111;
  --muted: #2a2a2a;
  --rule: #6c6c6c;
  --display: "IBM Plex Sans Condensed", "Arial Narrow", system-ui, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, Consolas, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --ground: #303030; --panel: #3a3a3a; --ink: #ececec; --muted: #b4b4b4; --rule: #474747; color-scheme: dark } }
:root[data-theme="dark"] { --ground: #303030; --panel: #3a3a3a; --ink: #ececec; --muted: #b4b4b4; --rule: #474747; color-scheme: dark }
body { background: var(--ground); color: var(--ink); font-family: var(--display); padding-block: 24px 48px;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
header { max-width: 70ch; display: grid; gap: 8px; margin-bottom: 28px; }
h1 { font-size: 1.6rem; font-weight: 600; margin: 0; text-wrap: balance; letter-spacing: 0.01em; }
header p { margin: 0; color: var(--muted); line-height: 1.5; font-size: 0.95rem; }
.thresholds { font-family: var(--mono); font-size: 0.8rem; color: var(--muted); }
main { display: grid; gap: 32px; }
.frame { display: grid; gap: 10px; border-top: 1px solid var(--rule); padding-top: 14px; }
.frame h2 { margin: 0; font-family: var(--mono); font-weight: 400; font-size: 0.8rem; color: var(--muted); }
.strip { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(220px, 1fr); gap: 12px; overflow-x: auto; padding-bottom: 6px; }
figure { margin: 0; display: grid; gap: 6px; align-content: start; min-width: 0; }
figure img, .same { width: 100%; aspect-ratio: 3 / 2; object-fit: contain; background: var(--panel); display: block; }
.same { display: grid; place-items: center; color: var(--muted); font-size: 0.85rem; }
figcaption { display: grid; gap: 2px; font-size: 0.85rem; }
figcaption b { font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; font-size: 0.75rem; }
figcaption span { font-family: var(--mono); font-size: 0.75rem; color: var(--muted); font-variant-numeric: tabular-nums; }
</style>
<header>
  <h1>Intent contact sheet</h1>
  <p>Each row is one photograph: the profile's prediction first, then the same prediction with one develop intent met. Under each frame, the sliders the intent moved. Rendered with the review screen's tone model, which has no camera-profile curve and runs far darker than Lightroom, so each row is brightened by one viewing offset applied to every column alike. Judge the direction and size of each change against the prediction beside it; colour and absolute brightness are not Lightroom's.</p>
  <p class="thresholds">${escape(one('note', ''))}</p>
</header>
<main>${rows.join('\n')}</main>
`;
writeFileSync(one('out'), page);
process.stderr.write(`wrote ${one('out')} (${(page.length / 1e6).toFixed(1)} MB)\n`);
