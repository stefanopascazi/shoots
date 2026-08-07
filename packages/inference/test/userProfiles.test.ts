/**
 * User-supplied learned profiles.
 *
 * These arrive as external JSON written by a different tool, so the validator is
 * the only thing between a malformed file and silently wrong stars on a whole
 * shoot. Every branch of it is exercised.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROFILE_NAMES } from '../src/profiles.js';
import {
  allProfileNames,
  listUserProfileNames,
  loadProfileFile,
  parseLinearEmbeddingProfile,
  resolveProfile,
} from '../src/userProfiles.js';

const VALID = {
  type: 'linear-embedding',
  name: 'my-style',
  embeddingModel: 'clip-vit-base-patch32',
  dim: 3,
  weights: [0.1, -0.2, 0.3],
  bias: 0.05,
  scoreNormalization: { mean: 0.4, std: 0.1 },
  focusReject: 0.3,
  focusSoft: 0.55,
  focusSoftCap: 1,
  aestheticStars: [
    { min: 0.9, stars: 5 },
    { min: 0.5, stars: 3 },
  ],
};

let home: string;
let saved: string | undefined;

const writeProfile = async (name: string, body: unknown): Promise<string> => {
  const dir = path.join(home, 'profiles');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  await writeFile(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
};

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'shoots-profiles-'));
  saved = process.env.SHOOTS_HOME;
  process.env.SHOOTS_HOME = home;
});

afterEach(async () => {
  if (saved === undefined) delete process.env.SHOOTS_HOME;
  else process.env.SHOOTS_HOME = saved;
  await rm(home, { recursive: true, force: true });
});

describe('parseLinearEmbeddingProfile, on a valid profile', () => {
  test('returns it normalized, and marked calibrated', () => {
    const parsed = parseLinearEmbeddingProfile(VALID, 'my-style.json');
    expect(parsed.type).toBe('linear-embedding');
    expect(parsed.name).toBe('my-style');
    expect(parsed.dim).toBe(3);
    expect(parsed.weights).toEqual([0.1, -0.2, 0.3]);
    expect(parsed.calibrated).toBe(true);
  });

  test('substitutes a description when the file has none', () => {
    expect(parseLinearEmbeddingProfile(VALID, 'x.json').description).toBe('Learned linear-embedding profile');
    expect(parseLinearEmbeddingProfile({ ...VALID, description: 'mine' }, 'x.json').description).toBe('mine');
  });

  test('copies the star table rather than aliasing the caller object', () => {
    const source = { ...VALID, aestheticStars: [{ min: 0.5, stars: 3 }] };
    const parsed = parseLinearEmbeddingProfile(source, 'x.json');
    source.aestheticStars[0]!.min = 0.9;
    expect(parsed.aestheticStars[0]!.min).toBe(0.5);
  });
});

describe('parseLinearEmbeddingProfile, on a malformed profile', () => {
  const rejects = (over: Record<string, unknown>, pattern: RegExp): void => {
    expect(() => parseLinearEmbeddingProfile({ ...VALID, ...over }, 'bad.json')).toThrow(pattern);
  };

  test('names the source file in every message', () => {
    expect(() => parseLinearEmbeddingProfile({ ...VALID, name: '' }, 'bad.json')).toThrow(
      /invalid profile bad\.json/,
    );
  });

  test('refuses a profile of the wrong kind', () => {
    rejects({ type: 'aspect-weights' }, /unsupported type 'aspect-weights'/);
  });

  test('requires a name and an embedding space', () => {
    rejects({ name: '' }, /missing name/);
    rejects({ embeddingModel: undefined }, /missing embeddingModel/);
  });

  test('requires a positive integer dim', () => {
    rejects({ dim: 0 }, /dim must be a positive integer/);
    rejects({ dim: 2.5 }, /dim must be a positive integer/);
    rejects({ dim: -3 }, /dim must be a positive integer/);
  });

  // The one that would otherwise score every photograph against a truncated head.
  test('requires exactly `dim` finite weights', () => {
    rejects({ weights: [0.1, 0.2] }, /weights must be 3 finite numbers/);
    rejects({ weights: [0.1, 0.2, Number.NaN] }, /weights must be 3 finite numbers/);
    rejects({ weights: 'nope' }, /weights must be 3 finite numbers/);
  });

  test('requires a numeric bias and normalization', () => {
    rejects({ bias: 'x' }, /bias must be a number/);
    rejects({ scoreNormalization: undefined }, /scoreNormalization must have numeric mean\/std/);
    rejects({ scoreNormalization: { mean: 0.4 } }, /scoreNormalization must have numeric mean\/std/);
  });

  test('requires the focus gate to be numbers and the cap to be a star', () => {
    rejects({ focusReject: null }, /focusReject\/focusSoft must be numbers/);
    rejects({ focusSoftCap: 6 }, /focusSoftCap must be an integer 0–5/);
    rejects({ focusSoftCap: 1.5 }, /focusSoftCap must be an integer 0–5/);
  });

  test('requires a non-empty, well-formed star table', () => {
    rejects({ aestheticStars: [] }, /aestheticStars must be a non-empty list/);
    rejects({ aestheticStars: [{ min: 0.5 }] }, /aestheticStars must be a non-empty list/);
    rejects({ aestheticStars: [{ min: 'x', stars: 3 }] }, /aestheticStars must be a non-empty list/);
  });
});

describe('loadProfileFile', () => {
  test('reads and validates a file from disk', async () => {
    const file = await writeProfile('my-style', VALID);
    expect((await loadProfileFile(file)).name).toBe('my-style');
  });

  test('reports unreadable JSON as a profile error naming the path', async () => {
    const file = await writeProfile('broken', '{ not json');
    expect(loadProfileFile(file)).rejects.toThrow(/cannot read profile/);
  });

  test('reports a missing file rather than throwing an fs error', async () => {
    expect(loadProfileFile(path.join(home, 'nope.json'))).rejects.toThrow(/cannot read profile/);
  });
});

describe('listUserProfileNames', () => {
  test('is empty when no profiles directory exists yet', async () => {
    expect(await listUserProfileNames()).toEqual([]);
  });

  test('lists the json files, sorted, without their extension', async () => {
    await writeProfile('zebra', VALID);
    await writeProfile('alpha', VALID);
    await writeFile(path.join(home, 'profiles', 'notes.txt'), 'ignored');
    expect(await listUserProfileNames()).toEqual(['alpha', 'zebra']);
  });
});

describe('resolveProfile', () => {
  test('prefers a built-in over a user file of the same name', async () => {
    await writeProfile('street', { ...VALID, name: 'street', bias: 999 });
    const resolved = await resolveProfile('street');
    expect(resolved!.type).toBe('aspect-weights');
  });

  test('loads and validates a user profile by name', async () => {
    await writeProfile('my-style', VALID);
    expect((await resolveProfile('my-style'))!.name).toBe('my-style');
  });

  test('is undefined for a name nobody defines', async () => {
    expect(await resolveProfile('ghost')).toBeUndefined();
  });

  test('still fails loudly on a user profile that exists but is broken', async () => {
    await writeProfile('broken', { ...VALID, weights: [1] });
    expect(resolveProfile('broken')).rejects.toThrow(/weights must be 3 finite numbers/);
  });
});

describe('allProfileNames', () => {
  test('is the built-ins alone when the user has none', async () => {
    expect(await allProfileNames()).toEqual([...PROFILE_NAMES]);
  });

  test('appends the user profiles after the built-ins', async () => {
    await writeProfile('my-style', VALID);
    expect(await allProfileNames()).toEqual([...PROFILE_NAMES, 'my-style']);
  });

  test('never lists a name twice when a user file shadows a built-in', async () => {
    await writeProfile('street', { ...VALID, name: 'street' });
    const names = await allProfileNames();
    expect(names.filter((n) => n === 'street').length).toBe(1);
  });
});
