/**
 * Caching the CLIP half of quality assessment.
 *
 * Three commands — `rate`, `embeddings`, `develop export` — want the same
 * embedding of the same frames, and until this landed all three computed it.
 * What the tests below pin is that they now share one entry, that sharpness is
 * shared with `cull` in both directions, and above all that the model runs
 * exactly as often as it has to and never once more.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { ScannedFile } from '@shoots/core';
import type {
  ImageInput,
  MeasureOptions,
  QualityAssessment,
  QualityMeasurement,
  QualityModel,
} from '@shoots/inference';
import { analyzeBlurCached } from '../../src/cache/blur.js';
import { decodeFloats, encodeFloats } from '../../src/cache/codec.js';
import { clipProducer } from '../../src/cache/producers.js';
import { measureQualityCached, assessCached } from '../../src/cache/quality.js';
import { DerivedCache } from '../../src/cache/store.js';

let home: string;
let catalog: string;
let savedHome: string | undefined;

/** A frame with real edges, so its Laplacian score is not a rounding artefact. */
const frame = async (name: string): Promise<string> => {
  const w = 320;
  const h = 240;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = (x >> 2) % 2 === 0 ? 20 : 235;
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

/**
 * A backend that answers deterministically and counts what it was asked to do.
 * The real one needs a provisioned ONNX archive; what is under test here is the
 * wiring around it, not the weights.
 */
class CountingModel implements QualityModel {
  measured = 0;
  interpreted = 0;
  /** Whether the last measure() was allowed to skip the Laplacian. */
  lastFocusPeakIn: number | undefined;

  constructor(
    private readonly weight = 1,
    readonly name = 'fake-clip/v1',
  ) {}

  async init(): Promise<void> {}

  async measure(image: ImageInput, options: MeasureOptions = {}): Promise<QualityMeasurement> {
    this.measured++;
    this.lastFocusPeakIn = options.focusPeak;
    const embedding = new Float32Array([0.125, -0.25, 0.5, 0.0078125]);
    if (options.focusPeak !== undefined) {
      return { embedding, focusPeak: options.focusPeak };
    }
    return {
      embedding,
      focusPeak: 900,
      laplacian: { score: 1234.5, focusPeak: 900, focusMap: { cols: 2, rows: 1, tiles: [1, 2] }, width: 320, height: 240 },
      pixelSource: 'file',
    };
  }

  interpret(measurement: QualityMeasurement): QualityAssessment {
    this.interpreted++;
    // The profile's influence, reduced to one number so a change is visible.
    const aesthetic = Math.min(1, this.weight * Math.abs(measurement.embedding[0]!));
    return {
      focus: measurement.focusPeak / (measurement.focusPeak + 250),
      aesthetic,
      aspects: [],
      keywords: [],
      embedding: Array.from(measurement.embedding),
    };
  }

  async scoreFocus(image: ImageInput): Promise<number> {
    return (await this.assess(image)).focus;
  }
  async scoreAesthetic(image: ImageInput): Promise<number> {
    return (await this.assess(image)).aesthetic;
  }
  async suggestKeywords(image: ImageInput): Promise<string[]> {
    return (await this.assess(image)).keywords;
  }
  async assess(image: ImageInput): Promise<QualityAssessment> {
    return this.interpret(await this.measure(image));
  }
  async dispose(): Promise<void> {}
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'shoots-qc-home-'));
  catalog = await mkdtemp(path.join(tmpdir(), 'shoots-qc-cat-'));
  savedHome = process.env.SHOOTS_HOME;
  process.env.SHOOTS_HOME = home;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.SHOOTS_HOME;
  else process.env.SHOOTS_HOME = savedHome;
  await rm(home, { recursive: true, force: true });
  await rm(catalog, { recursive: true, force: true });
});

describe('codec', () => {
  test('round-trips a float vector exactly', () => {
    // Exactly, not approximately: a cached score that differs in the third
    // decimal from a fresh one is the failure this cache must not have.
    const original = new Float32Array([0, 1, -1, 0.1, -0.0078125, 3.4e38, 1.2e-38]);
    const back = decodeFloats(encodeFloats(original))!;
    expect(Array.from(back)).toEqual(Array.from(original));
  });

  test('round-trips the width a CLIP embedding actually is', () => {
    const original = new Float32Array(512);
    for (let i = 0; i < 512; i++) original[i] = Math.sin(i) / 32;
    const back = decodeFloats(encodeFloats(original))!;
    expect(back.length).toBe(512);
    expect(Array.from(back)).toEqual(Array.from(original));
  });

  test('is null for anything that is not a float vector', () => {
    expect(decodeFloats(undefined)).toBeNull();
    expect(decodeFloats('')).toBeNull();
    expect(decodeFloats(42)).toBeNull();
    // Five bytes: not a whole number of float32.
    expect(decodeFloats(Buffer.from([1, 2, 3, 4, 5]).toString('base64'))).toBeNull();
  });
});

describe('measureQualityCached', () => {
  test('a cold frame runs the model once and stores both halves', async () => {
    const file = await frame('IMG_1.jpg');
    const entry = await scanned(file);
    const model = new CountingModel();

    const cold = await DerivedCache.open([file]);
    const first = await measureQualityCached(cold, model, entry);
    await cold.save();
    expect(model.measured).toBe(1);

    const warm = await DerivedCache.open([file]);
    const second = await measureQualityCached(warm, model, entry);
    expect(model.measured).toBe(1); // untouched
    expect(Array.from(second.embedding)).toEqual(Array.from(first.embedding));
    expect(second.focusPeak).toBe(first.focusPeak);
  });

  test('changing profile re-derives the stars without re-running the model', async () => {
    // The headline: `rate --profile a` then `rate --profile b` is a dot product,
    // not a forward pass.
    const file = await frame('IMG_1.jpg');
    const entry = await scanned(file);

    const street = new CountingModel(1);
    const cold = await DerivedCache.open([file]);
    const a = await assessCached(cold, street, entry);
    await cold.save();

    const portrait = new CountingModel(4);
    const warm = await DerivedCache.open([file]);
    const b = await assessCached(warm, portrait, entry);

    expect(portrait.measured).toBe(0);
    expect(portrait.interpreted).toBe(1);
    expect(b.aesthetic).not.toBe(a.aesthetic);
    expect(b.embedding).toEqual(a.embedding);
  });

  test('takes the sharpness cull already measured, and skips the Laplacian', async () => {
    const file = await frame('IMG_1.jpg');
    const entry = await scanned(file);

    const culled = await DerivedCache.open([file]);
    const analysis = await analyzeBlurCached(culled, entry, { threshold: 100 });
    await culled.save();

    const model = new CountingModel();
    const rating = await DerivedCache.open([file]);
    const measurement = await measureQualityCached(rating, model, entry);

    expect(model.lastFocusPeakIn).toBe(analysis.focusPeak);
    expect(measurement.focusPeak).toBe(analysis.focusPeak);
  });

  test('leaves sharpness behind for a later cull to pick up', async () => {
    // The other direction: `rate` first, then `cull` measures nothing.
    const file = await frame('IMG_1.jpg');
    const entry = await scanned(file);

    const model = new CountingModel();
    const rating = await DerivedCache.open([file]);
    const measurement = await measureQualityCached(rating, model, entry);
    await rating.save();

    const culling = await DerivedCache.open([file]);
    const analysis = await analyzeBlurCached(culling, entry, { threshold: 100 });
    expect(culling.counters.hits).toBe(1);
    expect(analysis.focusPeak).toBe(measurement.focusPeak);
    expect(analysis.score).toBe(1234.5);
  });

  test('measures sharpness alone when only the embedding is cached', async () => {
    // The shape a run leaves when it embedded but never measured sharpness —
    // and what an evicted-then-partly-rebuilt pack looks like too.
    const file = await frame('IMG_1.jpg');
    const entry = await scanned(file);
    const identity = { size: entry.size, mtimeMs: entry.mtime.getTime() };
    const model = new CountingModel();

    const seed = await DerivedCache.open([file]);
    seed.set(file, clipProducer(model.name), identity, { e: encodeFloats(new Float32Array([1, 2, 3, 4])) });
    await seed.save();

    const cache = await DerivedCache.open([file]);
    const measurement = await measureQualityCached(cache, model, entry);

    // No forward pass: the embedding was there. Sharpness came off a real decode.
    expect(model.measured).toBe(0);
    expect(Array.from(measurement.embedding)).toEqual([1, 2, 3, 4]);
    expect(measurement.focusPeak).toBeGreaterThan(0);

    // And it was stored, so a later cull finds it.
    await cache.save();
    const culling = await DerivedCache.open([file]);
    const analysis = await analyzeBlurCached(culling, entry, {});
    expect(culling.counters.hits).toBe(1);
    expect(analysis.focusPeak).toBe(measurement.focusPeak);
  });

  test('re-measures everything when the photograph changed', async () => {
    const file = await frame('IMG_1.jpg');
    const before = await scanned(file);
    const model = new CountingModel();
    const cold = await DerivedCache.open([file]);
    await measureQualityCached(cold, model, before);
    await cold.save();

    await writeFile(
      file,
      await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 9, g: 9, b: 9 } } })
        .jpeg()
        .toBuffer(),
    );
    const after = await scanned(file);

    const warm = await DerivedCache.open([file]);
    await measureQualityCached(warm, model, after);
    expect(model.measured).toBe(2);
    expect(warm.counters.stale).toBeGreaterThan(0);
  });

  test('a disabled cache measures every time', async () => {
    const file = await frame('IMG_1.jpg');
    const entry = await scanned(file);
    const model = new CountingModel();

    await measureQualityCached(DerivedCache.disabled(), model, entry);
    await measureQualityCached(DerivedCache.disabled(), model, entry);
    expect(model.measured).toBe(2);
  });

  test('a different backend does not read another one\'s embeddings', async () => {
    // The producer key carries the model name, so two embedding spaces cannot
    // be confused for one another.
    const file = await frame('IMG_1.jpg');
    const entry = await scanned(file);

    const first = new CountingModel();
    const cold = await DerivedCache.open([file]);
    await measureQualityCached(cold, first, entry);
    await cold.save();

    const other = new CountingModel(1, 'fake-clip/v2');
    const warm = await DerivedCache.open([file]);
    await measureQualityCached(warm, other, entry);
    expect(other.measured).toBe(1);
  });
});
