/**
 * The derived-value cache.
 *
 * One rule outranks every other test here: a hit must be indistinguishable from
 * a miss. The cache may cost a recomputation whenever it likes — that is only
 * time — but it may never hand back a number that describes a photograph as it
 * used to be. Most of what follows is that rule, approached from different
 * directions.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cacheDir } from '@shoots/core';
import { clearCache, DerivedCache, packPathFor } from '../../src/cache/store.js';
import {
  cacheUsage,
  DEFAULT_CACHE_MAX_BYTES,
  enforceCacheBudget,
  listPacks,
  parseCacheMax,
} from '../../src/cache/budget.js';

let home: string;
let catalog: string;
let savedHome: string | undefined;
let savedMax: string | undefined;
let savedEnabled: string | undefined;

const photo = async (rel: string, body = 'pixels'): Promise<string> => {
  const full = path.join(catalog, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body);
  return full;
};

/** The identity a scan would report for a real file. */
const identityOf = async (file: string): Promise<{ size: number; mtimeMs: number }> => {
  const info = await stat(file);
  return { size: info.size, mtimeMs: info.mtimeMs };
};

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'shoots-cache-home-'));
  catalog = await mkdtemp(path.join(tmpdir(), 'shoots-cache-cat-'));
  savedHome = process.env.SHOOTS_HOME;
  savedMax = process.env.SHOOTS_CACHE_MAX;
  savedEnabled = process.env.SHOOTS_CACHE;
  process.env.SHOOTS_HOME = home;
  delete process.env.SHOOTS_CACHE_MAX;
  delete process.env.SHOOTS_CACHE;
});

afterEach(async () => {
  for (const [key, value] of [
    ['SHOOTS_HOME', savedHome],
    ['SHOOTS_CACHE_MAX', savedMax],
    ['SHOOTS_CACHE', savedEnabled],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(home, { recursive: true, force: true });
  await rm(catalog, { recursive: true, force: true });
});

describe('DerivedCache', () => {
  test('returns what a previous run stored', async () => {
    const file = await photo('IMG_1.cr3');
    const id = await identityOf(file);

    const first = await DerivedCache.open([file]);
    expect(first.get(file, 'blur@1', id)).toBeUndefined();
    expect(first.counters.misses).toBe(1);
    first.set(file, 'blur@1', id, { score: 42 });
    await first.save();

    const second = await DerivedCache.open([file]);
    expect(second.get<{ score: number }>(file, 'blur@1', id)).toEqual({ score: 42 });
    expect(second.counters.hits).toBe(1);
  });

  test('misses when the photograph changed underneath it', async () => {
    // The whole safety argument: mtime moved, so every number describing the
    // old pixels goes, rather than being served for the new ones.
    const file = await photo('IMG_1.cr3');
    const before = await identityOf(file);
    const first = await DerivedCache.open([file]);
    first.set(file, 'blur@1', before, { score: 42 });
    await first.save();

    const after = { size: before.size, mtimeMs: before.mtimeMs + 1000 };
    const second = await DerivedCache.open([file]);
    expect(second.get(file, 'blur@1', after)).toBeUndefined();
    expect(second.counters.stale).toBe(1);
  });

  test('misses when the file kept its mtime but changed size', async () => {
    const file = await photo('IMG_1.cr3');
    const before = await identityOf(file);
    const first = await DerivedCache.open([file]);
    first.set(file, 'blur@1', before, { score: 42 });
    await first.save();

    const second = await DerivedCache.open([file]);
    expect(second.get(file, 'blur@1', { size: before.size + 1, mtimeMs: before.mtimeMs })).toBeUndefined();
  });

  test('a stale record takes every producer down with it', async () => {
    // Values keyed under different producers still describe the same pixels.
    const file = await photo('IMG_1.cr3');
    const before = await identityOf(file);
    const first = await DerivedCache.open([file]);
    first.set(file, 'blur@1', before, { score: 42 });
    first.set(file, 'clip@1', before, { embedding: [1, 2] });
    await first.save();

    const after = { size: before.size, mtimeMs: before.mtimeMs + 1 };
    const second = await DerivedCache.open([file]);
    expect(second.get(file, 'blur@1', after)).toBeUndefined();
    second.set(file, 'blur@1', after, { score: 7 });
    await second.save();

    const third = await DerivedCache.open([file]);
    expect(third.get(file, 'clip@1', after)).toBeUndefined();
    expect(third.get(file, 'blur@1', after)).toEqual({ score: 7 });
  });

  test('keeps other producers when the same file is re-measured unchanged', async () => {
    const file = await photo('IMG_1.cr3');
    const id = await identityOf(file);
    const first = await DerivedCache.open([file]);
    first.set(file, 'blur@1', id, { score: 42 });
    first.set(file, 'clip@1', id, { embedding: [1, 2] });
    await first.save();

    const second = await DerivedCache.open([file]);
    second.set(file, 'blur@1', id, { score: 43 });
    await second.save();

    const third = await DerivedCache.open([file]);
    expect(third.get(file, 'clip@1', id)).toEqual({ embedding: [1, 2] });
    expect(third.get(file, 'blur@1', id)).toEqual({ score: 43 });
  });

  test('misses a producer it has never seen, without disturbing the record', async () => {
    const file = await photo('IMG_1.cr3');
    const id = await identityOf(file);
    const cache = await DerivedCache.open([file]);
    cache.set(file, 'blur@1', id, { score: 42 });
    expect(cache.get(file, 'blur@2:d2048', id)).toBeUndefined();
    expect(cache.get(file, 'blur@1', id)).toEqual({ score: 42 });
  });

  test('sees what a run over the parent folder stored', async () => {
    // Culling `shoot/day1` then `shoot/` is the same photographs. Keying packs
    // on the folder the user typed would miss every one of them.
    const file = await photo('day1/IMG_1.cr3');
    const id = await identityOf(file);
    const narrow = await DerivedCache.open([file]);
    narrow.set(file, 'blur@1', id, { score: 42 });
    await narrow.save();

    const other = await photo('day2/IMG_2.cr3');
    const wide = await DerivedCache.open([file, other]);
    expect(wide.get(file, 'blur@1', id)).toEqual({ score: 42 });
  });

  test('keeps same-named folders from different trees apart', async () => {
    const a = path.join(catalog, 'a', '2026-08-02');
    const b = path.join(catalog, 'b', '2026-08-02');
    expect(packPathFor(a)).not.toBe(packPathFor(b));
    expect(path.basename(packPathFor(a))).toStartWith('2026-08-02-');
  });

  test('disabled, it never hits and writes nothing', async () => {
    const file = await photo('IMG_1.cr3');
    const id = await identityOf(file);
    const cache = await DerivedCache.open([file], { enabled: false });
    cache.set(file, 'blur@1', id, { score: 42 });
    await cache.save();

    expect(cache.get(file, 'blur@1', id)).toBeUndefined();
    expect(await listPacks()).toEqual([]);
  });

  test('SHOOTS_CACHE=0 disables it as firmly as the flag does', async () => {
    process.env.SHOOTS_CACHE = '0';
    const file = await photo('IMG_1.cr3');
    const id = await identityOf(file);
    const cache = await DerivedCache.open([file]);
    expect(cache.enabled).toBe(false);
    cache.set(file, 'blur@1', id, { score: 42 });
    await cache.save();
    expect(await listPacks()).toEqual([]);
  });

  test('survives a half-written line instead of failing the command', async () => {
    // What a run killed mid-write leaves behind. Losing that record costs a
    // recomputation; refusing to open the pack would cost the whole run.
    const good = await photo('IMG_1.cr3');
    const id = await identityOf(good);
    const seed = await DerivedCache.open([good]);
    seed.set(good, 'blur@1', id, { score: 42 });
    await seed.save();

    const pack = packPathFor(catalog);
    await writeFile(pack, (await readFile(pack, 'utf8')) + '{"file":"broken', 'utf8');

    const cache = await DerivedCache.open([good]);
    expect(cache.get(good, 'blur@1', id)).toEqual({ score: 42 });
  });

  test('writes nothing when a run only reads', async () => {
    const file = await photo('IMG_1.cr3');
    const id = await identityOf(file);
    const seed = await DerivedCache.open([file]);
    seed.set(file, 'blur@1', id, { score: 42 });
    await seed.save();
    const size = (await stat(packPathFor(catalog))).size;

    const reader = await DerivedCache.open([file]);
    reader.get(file, 'blur@1', id);
    await reader.save();
    expect((await stat(packPathFor(catalog))).size).toBe(size);
  });
});

describe('parseCacheMax', () => {
  test('reads the spellings somebody would actually type', () => {
    expect(parseCacheMax('512MB')).toBe(512 * 1024 * 1024);
    expect(parseCacheMax('2gb')).toBe(2 * 1024 ** 3);
    expect(parseCacheMax('1.5 GB')).toBe(Math.round(1.5 * 1024 ** 3));
    expect(parseCacheMax('4096')).toBe(4096);
    expect(parseCacheMax('0')).toBe(0);
  });

  test('falls back to the default rather than failing a command', () => {
    expect(parseCacheMax(undefined)).toBe(DEFAULT_CACHE_MAX_BYTES);
    expect(parseCacheMax('plenty')).toBe(DEFAULT_CACHE_MAX_BYTES);
    expect(parseCacheMax('-5MB')).toBe(DEFAULT_CACHE_MAX_BYTES);
  });
});

describe('enforceCacheBudget', () => {
  /** Two packs, the first deliberately older than the second. */
  const seedTwoPacks = async (): Promise<{ oldPack: string; newPack: string }> => {
    const old = await photo('old/IMG_1.cr3');
    const oldId = await identityOf(old);
    const a = await DerivedCache.open([old]);
    a.set(old, 'blur@1', oldId, { score: 1, pad: 'x'.repeat(400) });
    await a.save();

    const fresh = await photo('new/IMG_2.cr3');
    const freshId = await identityOf(fresh);
    const b = await DerivedCache.open([fresh]);
    b.set(fresh, 'blur@1', freshId, { score: 2, pad: 'x'.repeat(400) });
    await b.save();

    const { utimes } = await import('node:fs/promises');
    const ancient = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);
    await utimes(packPathFor(path.join(catalog, 'old')), ancient, ancient);
    return {
      oldPack: packPathFor(path.join(catalog, 'old')),
      newPack: packPathFor(path.join(catalog, 'new')),
    };
  };

  test('does nothing while the cache fits', async () => {
    await seedTwoPacks();
    expect((await enforceCacheBudget()).evicted).toBe(0);
    expect((await listPacks()).length).toBe(2);
  });

  test('drops the oldest shoot first', async () => {
    const { oldPack, newPack } = await seedTwoPacks();
    process.env.SHOOTS_CACHE_MAX = String((await cacheUsage()).bytes - 1);

    const result = await enforceCacheBudget();
    expect(result.evicted).toBe(1);
    expect(existsSync(oldPack)).toBe(false);
    expect(existsSync(newPack)).toBe(true);
  });

  test('never evicts the shoot the current run is using', async () => {
    // Evicting the pack just written would make every run a cold one.
    const { oldPack, newPack } = await seedTwoPacks();
    process.env.SHOOTS_CACHE_MAX = '0';

    const result = await enforceCacheBudget(new Set([newPack]));
    expect(result.evicted).toBe(1);
    expect(existsSync(oldPack)).toBe(false);
    expect(existsSync(newPack)).toBe(true);
  });

  test('a save holds the cache to its ceiling on the way out', async () => {
    await seedTwoPacks();
    process.env.SHOOTS_CACHE_MAX = '1';

    const third = await photo('third/IMG_3.cr3');
    const id = await identityOf(third);
    const cache = await DerivedCache.open([third]);
    cache.set(third, 'blur@1', id, { score: 3 });
    await cache.save();

    // Its own pack survives; the shoots it is not using do not.
    expect(existsSync(packPathFor(path.join(catalog, 'third')))).toBe(true);
    expect((await listPacks()).length).toBe(1);
  });
});

describe('clearCache', () => {
  test('drops every pack and reports how many', async () => {
    const a = await photo('one/IMG_1.cr3');
    const b = await photo('two/IMG_2.cr3');
    for (const file of [a, b]) {
      const cache = await DerivedCache.open([file]);
      cache.set(file, 'blur@1', await identityOf(file), { score: 1 });
      await cache.save();
    }
    expect(await clearCache()).toBe(2);
    expect(await listPacks()).toEqual([]);
  });

  test('is a no-op when nothing was ever cached', async () => {
    expect(existsSync(cacheDir())).toBe(false);
    expect(await clearCache()).toBe(0);
  });
});
