/**
 * Caching the colour-feature vector.
 *
 * These features are unlike the other two cached producers in one way that
 * matters: they do not describe a photograph, they describe a *rendering* of
 * one. The same RAW measured off its embedded preview and off a neutral
 * external render is two different vectors, and most of what follows is the
 * insistence that the cache knows the difference.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { COLOR_FEATURE_NAMES } from '@shoots/imaging';
import { colorFeaturesCached } from '../../src/cache/color.js';
import { colorProducer, colorSourceId } from '../../src/cache/producers.js';
import { encodeDoubles, decodeDoubles } from '../../src/cache/codec.js';
import { DerivedCache } from '../../src/cache/store.js';

let home: string;
let savedHome: string | undefined;

const FILE = path.resolve('/catalog/IMG_1.cr3');
const IDENTITY = { size: 1234, mtimeMs: 1700000000000 };

/** A full-width vector whose values are recognisable. */
const vectorOf = (seed: number): number[] =>
  COLOR_FEATURE_NAMES.map((_, i) => seed + i / 7);

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'shoots-color-home-'));
  savedHome = process.env.SHOOTS_HOME;
  process.env.SHOOTS_HOME = home;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.SHOOTS_HOME;
  else process.env.SHOOTS_HOME = savedHome;
  await rm(home, { recursive: true, force: true });
});

describe('encodeDoubles / decodeDoubles', () => {
  test('round-trips at full precision', () => {
    // Colour features reach the trainer unrounded, so anything lost here would
    // be lost from what the model fits on.
    const original = [0.1, 1 / 3, -1e-12, Number.MAX_SAFE_INTEGER, Math.PI];
    expect(decodeDoubles(encodeDoubles(original))).toEqual(original);
  });

  test('is null for anything that is not a double vector', () => {
    expect(decodeDoubles(undefined)).toBeNull();
    expect(decodeDoubles('')).toBeNull();
    // Four bytes: a float32, not a float64.
    expect(decodeDoubles(Buffer.from([1, 2, 3, 4]).toString('base64'))).toBeNull();
  });
});

describe('colorSourceId', () => {
  test('separates the renderings a vector can come from', () => {
    const dev = { command: 'dcraw_emu', argsTemplate: '-w -o 1 {in} {out}' };
    const ids = new Set([
      colorSourceId('preview'),
      colorSourceId('float-dng'),
      colorSourceId('neutral', dev),
    ]);
    expect(ids.size).toBe(3);
  });

  test('changing the developer changes the identity', () => {
    // Swapping dcraw_emu for RawTherapee, or merely changing the exposure flags,
    // produces different pixels — and so must produce a different key.
    const base = { command: 'dcraw_emu', argsTemplate: '-w -o 1 {in} {out}' };
    expect(colorSourceId('neutral', base)).toBe(colorSourceId('neutral', { ...base }));
    expect(colorSourceId('neutral', base)).not.toBe(
      colorSourceId('neutral', { ...base, command: 'rawtherapee-cli' }),
    );
    expect(colorSourceId('neutral', base)).not.toBe(
      colorSourceId('neutral', { ...base, argsTemplate: '-w -o 2 {in} {out}' }),
    );
  });
});

describe('colorFeaturesCached', () => {
  test('computes once, then reads', async () => {
    let computed = 0;
    const compute = async (): Promise<number[]> => {
      computed++;
      return vectorOf(1);
    };

    const cold = await DerivedCache.open([FILE]);
    const first = await colorFeaturesCached(cold, FILE, IDENTITY, 'preview', compute);
    await cold.save();

    const warm = await DerivedCache.open([FILE]);
    const second = await colorFeaturesCached(warm, FILE, IDENTITY, 'preview', compute);

    expect(computed).toBe(1);
    expect(second).toEqual(first);
  });

  test('a different rendering is a different measurement', async () => {
    // The failure this prevents: `--baseline external` answering with what
    // `--baseline embedded-preview` measured.
    const preview = vectorOf(10);
    const neutral = vectorOf(20);

    const cache = await DerivedCache.open([FILE]);
    const a = await colorFeaturesCached(cache, FILE, IDENTITY, 'preview', async () => preview);
    const b = await colorFeaturesCached(cache, FILE, IDENTITY, 'neutral-abc12345', async () => neutral);
    await cache.save();

    expect(a).toEqual(preview);
    expect(b).toEqual(neutral);

    const warm = await DerivedCache.open([FILE]);
    const failIfCalled = async (): Promise<number[]> => {
      throw new Error('should have been a hit');
    };
    expect(await colorFeaturesCached(warm, FILE, IDENTITY, 'preview', failIfCalled)).toEqual(preview);
    expect(await colorFeaturesCached(warm, FILE, IDENTITY, 'neutral-abc12345', failIfCalled)).toEqual(neutral);
  });

  test('refuses a stored vector of the wrong width', async () => {
    // Should be impossible — changing the feature set bumps the producer
    // version — but it is the one mistake nothing else would catch.
    const cache = await DerivedCache.open([FILE]);
    cache.set(FILE, colorProducer('preview'), IDENTITY, { v: encodeDoubles([1, 2, 3]) });

    let computed = 0;
    const result = await colorFeaturesCached(cache, FILE, IDENTITY, 'preview', async () => {
      computed++;
      return vectorOf(3);
    });
    expect(computed).toBe(1);
    expect(result).toHaveLength(COLOR_FEATURE_NAMES.length);
  });

  test('recomputes for a photograph that changed', async () => {
    let computed = 0;
    const compute = async (): Promise<number[]> => {
      computed++;
      return vectorOf(computed);
    };

    const cold = await DerivedCache.open([FILE]);
    await colorFeaturesCached(cold, FILE, IDENTITY, 'preview', compute);
    await cold.save();

    const warm = await DerivedCache.open([FILE]);
    await colorFeaturesCached(warm, FILE, { ...IDENTITY, mtimeMs: IDENTITY.mtimeMs + 1 }, 'preview', compute);
    expect(computed).toBe(2);
  });

  test('a disabled cache computes every time', async () => {
    let computed = 0;
    const compute = async (): Promise<number[]> => {
      computed++;
      return vectorOf(1);
    };
    await colorFeaturesCached(DerivedCache.disabled(), FILE, IDENTITY, 'preview', compute);
    await colorFeaturesCached(DerivedCache.disabled(), FILE, IDENTITY, 'preview', compute);
    expect(computed).toBe(2);
  });

  test('survives a corrupt stored value instead of failing the export', async () => {
    const cache = await DerivedCache.open([FILE]);
    cache.set(FILE, colorProducer('preview'), IDENTITY, { v: 'not base64 floats!' });
    const result = await colorFeaturesCached(cache, FILE, IDENTITY, 'preview', async () => vectorOf(5));
    expect(result).toEqual(vectorOf(5));
  });
});
