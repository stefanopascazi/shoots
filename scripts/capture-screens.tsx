/**
 * Generates the terminal screenshots published in `assets/screens/`.
 *
 * Usage:
 *   bun scripts/capture-screens.tsx                 # every scene
 *   bun scripts/capture-screens.tsx shell palette   # only these
 *   bun scripts/capture-screens.tsx --list
 *
 * How it works: each scene produces a real ANSI byte stream — either by mounting
 * the actual Ink component against a fake TTY and typing into it, or by spawning
 * the built CLI with colour forced on — which a small terminal emulator replays
 * into a cell grid, which is then drawn as an SVG window and rasterised by sharp.
 * Nothing in the images is mock text: if a scene cannot run, it is skipped.
 *
 * Scenes that operate on photographs need a folder of real RAW/JPEG files. Point
 * SHOOTS_SHOTS_SOURCE at one (default: `test/Raw`); the script copies a handful
 * into `demo/` (gitignored) so the paths on screen stay short. Keep that staging
 * folder between runs with SHOOTS_SHOTS_KEEP_DEMO=1.
 *
 * Requires: `npm run build` (the CLI scenes spawn `packages/cli/dist/cli.js`).
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { SceneContext } from './screens/scenes.js';

const repoRoot = path.resolve(import.meta.dir, '..');
const outDir = path.join(repoRoot, 'assets', 'screens');
const demoDir = path.join(repoRoot, 'demo');
const cliPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'cli.js');

const RAW_EXT = /\.(cr2|cr3|nef|arw|raf|dng|orf|rw2|jpe?g|tiff?|png)$/i;
const DEMO_FILES = 8;

// --- environment, before anything that reads it at import time --------------
// chalk locks its colour level, and version.ts its literals, on first import.
// Both have to be settled before the Ink components are loaded, hence the
// dynamic imports below.
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
process.env.FORCE_COLOR ??= '3';
process.env.SHOOTS_VERSION ??= pkg.version;
process.env.SHOOTS_AUTHOR ??= typeof pkg.author === 'string' ? pkg.author : (pkg.author?.name ?? '');

const { toPng, toSvg } = await import('./screens/render.js');
const { SCENES } = await import('./screens/scenes.js');

const args = process.argv.slice(2);
if (args.includes('--list')) {
  for (const scene of SCENES) console.log(`${scene.name.padEnd(10)} ${scene.description}`);
  process.exit(0);
}
const wanted = args.filter((a) => !a.startsWith('-'));
const scenes = wanted.length > 0 ? SCENES.filter((s) => wanted.includes(s.name)) : SCENES;
if (scenes.length === 0) {
  console.error(`no scene matches ${wanted.join(', ')} — try --list`);
  process.exit(2);
}

if (!existsSync(cliPath)) {
  console.error(`missing ${path.relative(repoRoot, cliPath)} — run \`npm run build\` first`);
  process.exit(2);
}

/** Breadth-first walk for the first `limit` images under `root`. */
function findImages(root: string, limit: number): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    if (found.length >= limit) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const file of entries.filter((e) => RAW_EXT.test(e))) {
      if (found.length >= limit) return;
      found.push(path.join(dir, file));
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      const full = path.join(dir, entry);
      try {
        if (statSync(full).isDirectory()) walk(full);
      } catch {
        /* unreadable entry: skip */
      }
    }
  };
  walk(root);
  return found;
}

/**
 * Stages a small demo catalog. Reuses an already-staged one, so repeated runs
 * do not re-copy hundreds of megabytes of RAW.
 */
function stageDemo(): boolean {
  const rawDir = path.join(demoDir, 'raw');
  if (existsSync(rawDir) && readdirSync(rawDir).some((f) => RAW_EXT.test(f))) return true;

  const source = process.env.SHOOTS_SHOTS_SOURCE ?? path.join(repoRoot, 'test', 'Raw');
  if (!existsSync(source)) return false;
  const images = findImages(source, DEMO_FILES);
  if (images.length === 0) return false;

  mkdirSync(rawDir, { recursive: true });
  for (const image of images) cpSync(image, path.join(rawDir, path.basename(image)));
  console.log(`staged ${images.length} image(s) into ${path.relative(repoRoot, rawDir)}`);
  return true;
}

const hasImages = stageDemo();
const ctx: SceneContext = { cliPath, demoDir, rawDir: 'raw' };

mkdirSync(outDir, { recursive: true });
if (!hasImages) {
  console.warn('no source images found — scenes that analyse photographs will be skipped');
  console.warn('set SHOOTS_SHOTS_SOURCE=<folder of RAW/JPEG files> to capture them');
}

let written = 0;
let skipped = 0;

for (const scene of scenes) {
  if (scene.needsImages && !hasImages) {
    console.log(`${scene.name} … skipped (no images)`);
    skipped += 1;
    continue;
  }
  process.stdout.write(`${scene.name} … `);
  try {
    const screen = await scene.capture(ctx);
    if (!screen) {
      console.log('skipped');
      skipped += 1;
      continue;
    }
    const options = { title: scene.title, scale: 2 };
    const png = await toPng(screen, options);
    writeFileSync(path.join(outDir, `${scene.name}.png`), png);
    writeFileSync(path.join(outDir, `${scene.name}.svg`), toSvg(screen, options));
    console.log(
      `${screen.cols}x${screen.rows} → assets/screens/${scene.name}.png (${Math.round(png.length / 1024)} KB)`,
    );
    written += 1;
  } catch (error) {
    console.log('failed');
    console.error(`  ${(error as Error).message.split('\n')[0]}`);
    skipped += 1;
  }
}

// --- index ------------------------------------------------------------------
// A small manifest so whoever consumes these (docs, web app) has the caption
// and the geometry without opening every file.
const index = [
  '# Screens',
  '',
  'Terminal screenshots of `shoots`, generated by `scripts/capture-screens.tsx`',
  '(`npm run build:screens`). Every one is a capture of real output — the Ink UIs',
  'driven by keystrokes, the batch commands actually executed. Do not edit by hand.',
  '',
  '| Screen | PNG | SVG | What it shows |',
  '| --- | --- | --- | --- |',
];
for (const scene of SCENES) {
  const png = `${scene.name}.png`;
  const svg = `${scene.name}.svg`;
  if (!existsSync(path.join(outDir, png))) continue;
  index.push(
    `| \`${scene.name}\` | [${png}](./${png}) | [${svg}](./${svg}) | ${scene.description} |`,
  );
}
writeFileSync(path.join(outDir, 'README.md'), `${index.join('\n')}\n`);

console.log(`\n${written} screen(s) written, ${skipped} skipped`);
if (process.env.SHOOTS_SHOTS_KEEP_DEMO !== '1' && existsSync(demoDir)) {
  // The staged RAW copies are large; drop them unless asked to keep them.
  rmSync(demoDir, { recursive: true, force: true });
}
process.exit(written === 0 ? 1 : 0);
