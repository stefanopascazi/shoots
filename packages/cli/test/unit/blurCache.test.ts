/**
 * Blur analysis over the cache.
 *
 * The property that matters is that a hit is invisible: the same photograph
 * must produce the same verdict whether the pixels were decoded this run or
 * last. The second property is why the split exists at all — changing a
 * threshold must reclassify from the cache instead of measuring again.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { analyzeBlur } from '@shoots/imaging';
import type { ScannedFile } from '@shoots/core';
import { analyzeBlurCached, BLUR_ANALYSIS_MAX_DIMENSION } from '../../src/cache/blur.js';
import { DerivedCache } from '../../src/cache/store.js';

let home: string;
let catalog: string;
let savedHome: string | undefined;

/** A frame with real edges, so its Laplacian score is not a rounding artefact. */
const sharpFrame = async (name: string): Promise<string> => {
  const w = 320;
  const h = 240;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = (x >> 2) % 2 === 0 ? 20 : 235; // hard vertical stripes
      const i = (y * w + x) * 3;
      raw[i] = raw[i + 1] = raw[i + 2] = v;
    }
  }
  const file = path.join(catalog, name);
  await writeFile(file, await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 95 }).toBuffer());
  return file;
};

const scanned = async (file: string): Promise<ScannedFile> => {
  const info = await stat(file);
  return {
    path: file,
    name: path.basename(file),
    ext: path.extname(file).slice(1),
    kind: 'processed',
    size: info.size,
    mtime: info.mtime,
  };
};

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'shoots-blurcache-home-'));
  catalog = await mkdtemp(path.join(tmpdir(), 'shoots-blurcache-cat-'));
  savedHome = process.env.SHOOTS_HOME;
  process.env.SHOOTS_HOME = home;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.SHOOTS_HOME;
  else process.env.SHOOTS_HOME = savedHome;
  await rm(home, { recursive: true, force: true });
  await rm(catalog, { recursive: true, force: true });
});

describe('analyzeBlurCached', () => {
  test('a hit answers exactly what measuring again would have', async () => {
    const file = await sharpFrame('IMG_1.jpg');
    const entry = await scanned(file);
    const options = { threshold: 100, focusThreshold: 250, focusRescue: true };

    const cold = await DerivedCache.open([file]);
    const fresh = await analyzeBlurCached(cold, entry, options);
    await cold.save();

    const warm = await DerivedCache.open([file]);
    const cached = await analyzeBlurCached(warm, entry, options);
    expect(warm.counters.hits).toBe(1);
    expect(cached).toEqual(fresh);
  });

  test('agrees with the uncached path it replaced', async () => {
    const file = await sharpFrame('IMG_1.jpg');
    const entry = await scanned(file);
    const options = { threshold: 100, focusThreshold: 250, focusRescue: true };

    const direct = await analyzeBlur(file, { ...options, maxDimension: BLUR_ANALYSIS_MAX_DIMENSION });
    const viaCache = await analyzeBlurCached(DerivedCache.disabled(), entry, options);
    expect(viaCache).toEqual(direct);
  });

  test('a new threshold reclassifies from the cache instead of measuring again', async () => {
    // The whole point of caching the measurement rather than the verdict:
    // hunting for the right threshold costs one decode, not one per attempt.
    const file = await sharpFrame('IMG_1.jpg');
    const entry = await scanned(file);

    const cold = await DerivedCache.open([file]);
    const lenient = await analyzeBlurCached(cold, entry, { threshold: 1 });
    await cold.save();

    const warm = await DerivedCache.open([file]);
    const strict = await analyzeBlurCached(warm, entry, { threshold: 1e9, focusThreshold: 1e9 });
    expect(warm.counters.hits).toBe(1);
    expect(warm.counters.writes).toBe(0);

    expect(lenient.verdict).toBe('sharp');
    expect(strict.verdict).toBe('blurry');
    // Same measurement underneath both verdicts.
    expect(strict.score).toBe(lenient.score);
    expect(strict.focusPeak).toBe(lenient.focusPeak);
  });

  test('re-measures a frame that was replaced on disk', async () => {
    const file = await sharpFrame('IMG_1.jpg');
    const before = await scanned(file);
    const cold = await DerivedCache.open([file]);
    await analyzeBlurCached(cold, before, { threshold: 100 });
    await cold.save();

    // A flat frame where a striped one used to be: any cached score would be a
    // lie, and the mtime is what catches it.
    await writeFile(
      file,
      await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 128, g: 128, b: 128 } } })
        .jpeg()
        .toBuffer(),
    );
    const after = await scanned(file);

    const warm = await DerivedCache.open([file]);
    const result = await analyzeBlurCached(warm, after, { threshold: 100 });
    expect(warm.counters.hits).toBe(0);
    expect(warm.counters.stale).toBe(1);
    expect(result.score).toBeLessThan(1);
  });

  test('keeps the focus map, so the review heatmap is a hit too', async () => {
    const file = await sharpFrame('IMG_1.jpg');
    const entry = await scanned(file);
    const cold = await DerivedCache.open([file]);
    const fresh = await analyzeBlurCached(cold, entry, {});
    await cold.save();

    const warm = await DerivedCache.open([file]);
    const cached = await analyzeBlurCached(warm, entry, {});
    expect(cached.focusMap.tiles).toEqual(fresh.focusMap.tiles);
    expect(cached.focusMap.cols).toBe(fresh.focusMap.cols);
  });
});
