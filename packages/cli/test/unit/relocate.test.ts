/**
 * Moving rejects out of the way, and the triage marks that have to follow them.
 *
 * The batch form exists for a reason worth protecting: following one mark reads
 * and rewrites every store file on the machine, so a per-file call over a pile
 * of rejects is quadratic in the size of the pile. What the tests below pin is
 * that batching it did not lose a mark, an error, or the mirrored structure.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mirrorDestination, relocate, relocateAll } from '../../src/relocate.js';
import { readMarks, TriageStore } from '../../src/triage/store.js';

let home: string;
let catalog: string;
let dest: string;
let savedHome: string | undefined;

const photo = async (rel: string): Promise<string> => {
  const full = path.join(catalog, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, rel);
  return full;
};

const markOne = async (file: string, marks: Record<string, unknown>): Promise<void> => {
  const store = await TriageStore.open(catalog);
  await store.mark(file, marks, 'cull', { tool: 'cull@test' });
  await store.save();
};

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'shoots-reloc-home-'));
  catalog = await mkdtemp(path.join(tmpdir(), 'shoots-reloc-cat-'));
  dest = await mkdtemp(path.join(tmpdir(), 'shoots-reloc-dest-'));
  savedHome = process.env.SHOOTS_HOME;
  process.env.SHOOTS_HOME = home;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.SHOOTS_HOME;
  else process.env.SHOOTS_HOME = savedHome;
  await Promise.all([home, catalog, dest].map((d) => rm(d, { recursive: true, force: true })));
});

describe('mirrorDestination', () => {
  test('preserves the position under the scan root', () => {
    expect(mirrorDestination('/cat', '/cat/day1/IMG_1.cr3', '/out')).toBe(path.join('/out', 'day1', 'IMG_1.cr3'));
  });

  test('falls back to the basename for a file outside the root', () => {
    expect(mirrorDestination('/cat', '/elsewhere/IMG_1.cr3', '/out')).toBe(path.join('/out', 'IMG_1.cr3'));
  });
});

describe('relocate', () => {
  test('moves the file and follows its mark', async () => {
    const file = await photo('day1/IMG_1.cr3');
    await markOne(file, { reject: true });

    const to = await relocate(catalog, file, dest);
    expect(to).toBe(path.join(dest, 'day1', 'IMG_1.cr3'));
    expect(existsSync(file)).toBe(false);
    expect((await readMarks([to])).get(to)!.marks).toEqual({ reject: true });
  });

  test('leaves the original — and its mark — in place when copying', async () => {
    const file = await photo('IMG_1.cr3');
    await markOne(file, { reject: true });

    const to = await relocate(catalog, file, dest, { move: false });
    expect(existsSync(file)).toBe(true);
    expect(existsSync(to)).toBe(true);
    expect((await readMarks([file])).has(file)).toBe(true);
    expect((await readMarks([to])).has(to)).toBe(false);
  });
});

describe('relocateAll', () => {
  test('moves every file, mirroring the structure, and follows every mark', async () => {
    const files = await Promise.all([
      photo('day1/IMG_1.cr3'),
      photo('day1/IMG_2.cr3'),
      photo('day2/IMG_3.cr3'),
    ]);
    for (const f of files) await markOne(f, { reject: true });

    const { relocated, errors } = await relocateAll(catalog, files, dest);
    expect(errors).toEqual([]);
    expect(relocated.map((r) => path.relative(dest, r.dest))).toEqual([
      path.join('day1', 'IMG_1.cr3'),
      path.join('day1', 'IMG_2.cr3'),
      path.join('day2', 'IMG_3.cr3'),
    ]);
    for (const f of files) expect(existsSync(f)).toBe(false);
    expect((await readMarks(files)).size).toBe(0);
    for (const r of relocated) {
      expect((await readMarks([r.dest])).get(r.dest)!.marks).toEqual({ reject: true });
    }
  });

  test('carries the file contents across, not just the name', async () => {
    const file = await photo('IMG_1.cr3');
    const { relocated } = await relocateAll(catalog, [file], dest);
    expect(await readFile(relocated[0]!.dest, 'utf8')).toBe('IMG_1.cr3');
  });

  test('reports the file that would not move and still relocates the rest', async () => {
    // One bad frame in a reject pile must not cost the photographer the pile.
    const good = await photo('IMG_1.cr3');
    const missing = path.join(catalog, 'ghost.cr3');
    const alsoGood = await photo('IMG_2.cr3');

    const { relocated, errors } = await relocateAll(catalog, [good, missing, alsoGood], dest);
    expect(relocated.map((r) => r.source)).toEqual([good, alsoGood]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.file).toBe(missing);
    expect(errors[0]!.error).toStartWith('move failed:');
  });

  test('copying leaves originals and their marks alone', async () => {
    const file = await photo('IMG_1.cr3');
    await markOne(file, { stars: 3 });

    const { relocated } = await relocateAll(catalog, [file], dest, { move: false });
    expect(existsSync(file)).toBe(true);
    expect((await readMarks([file])).get(file)!.marks).toEqual({ stars: 3 });
    expect((await readMarks([relocated[0]!.dest])).size).toBe(0);
  });

  test('accepts an empty set', async () => {
    expect(await relocateAll(catalog, [], dest)).toEqual({ relocated: [], errors: [] });
  });
});
