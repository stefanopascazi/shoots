/**
 * The triage store.
 *
 * Two rules define it: nothing is ever written beside the photographs, and a
 * lookup crosses *every* shoot file — culling `shoot/day1` and developing
 * `shoot/` are the same photographs, and keying the lookup on whichever folder
 * the user happened to type would silently lose the marks.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  consumeMarks,
  countPendingUnder,
  moveMarks,
  purgeMarks,
  readAllMarks,
  readMarks,
  storePathFor,
  TriageStore,
} from '../../src/triage/store.js';

let home: string;
let catalog: string;
let savedHome: string | undefined;

/** The ACR convention, which is what both real callers of the count use. */
const xmpFor = (file: string): string =>
  path.join(path.dirname(file), `${path.parse(file).name}.xmp`);

const photo = async (rel: string): Promise<string> => {
  const full = path.join(catalog, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, 'pixels');
  return full;
};

const markOne = async (target: string, file: string, marks: Record<string, unknown>): Promise<void> => {
  const store = await TriageStore.open(target);
  await store.mark(file, marks, 'cull', { tool: 'cull@test' });
  await store.save();
};

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'shoots-store-home-'));
  catalog = await mkdtemp(path.join(tmpdir(), 'shoots-store-cat-'));
  savedHome = process.env.SHOOTS_HOME;
  process.env.SHOOTS_HOME = home;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.SHOOTS_HOME;
  else process.env.SHOOTS_HOME = savedHome;
  await rm(home, { recursive: true, force: true });
  await rm(catalog, { recursive: true, force: true });
});

describe('storePathFor', () => {
  test('lives under the shoots home, never beside the photographs', () => {
    const store = storePathFor(catalog);
    expect(store.startsWith(path.resolve(home))).toBe(true);
    expect(store.startsWith(path.resolve(catalog))).toBe(false);
  });

  test('names the file after the folder a human would recognise', () => {
    expect(path.basename(storePathFor(path.join(catalog, '2026-07-19')))).toMatch(/^2026-07-19-[0-9a-f]{8}\.jsonl$/);
  });

  // 2026-07-19 is the most reusable folder name in photography.
  test('keeps two shoots of the same name apart', () => {
    const a = storePathFor(path.join(catalog, 'trip-a', '2026-07-19'));
    const b = storePathFor(path.join(catalog, 'trip-b', '2026-07-19'));
    expect(a).not.toBe(b);
  });

  test('is stable regardless of how the path was spelled', () => {
    expect(storePathFor(path.join(catalog, 'a', '..', 'a'))).toBe(storePathFor(path.join(catalog, 'a')));
  });
});

describe('TriageStore.mark', () => {
  test('records a mark and reads it back', async () => {
    const file = await photo('IMG_1.cr3');
    await markOne(catalog, file, { reject: true });

    const marks = await readMarks([file]);
    expect(marks.get(file)!.marks).toEqual({ reject: true });
    expect(marks.get(file)!.sources.cull!.tool).toBe('cull@test');
    expect(Number.isNaN(Date.parse(marks.get(file)!.sources.cull!.at))).toBe(false);
  });

  test('merges a second producer instead of replacing the first', async () => {
    const file = await photo('IMG_1.cr3');
    const store = await TriageStore.open(catalog);
    await store.mark(file, { reject: true }, 'cull', { tool: 'cull@test' });
    await store.mark(file, { stars: 4 }, 'rate', { tool: 'rate@test' });
    await store.save();

    const record = (await readMarks([file])).get(file)!;
    expect(record.marks).toEqual({ reject: true, stars: 4 });
    expect(Object.keys(record.sources).sort()).toEqual(['cull', 'rate']);
  });

  test('carries size and mtime as a tripwire for a file replaced underneath', async () => {
    const file = await photo('IMG_1.cr3');
    await markOne(catalog, file, { reject: true });
    const record = (await readMarks([file])).get(file)!;
    expect(record.size).toBe('pixels'.length);
    expect(record.mtimeMs).toBeGreaterThan(0);
  });

  test('takes the tripwire from the caller when it already has it', async () => {
    // The scan reported these; a second stat per photograph is a round trip
    // bought for nothing, and on a network catalog it is the whole pass.
    const file = await photo('IMG_1.cr3');
    const store = await TriageStore.open(catalog);
    await store.mark(file, { reject: true }, 'cull', { tool: 'cull@test' }, { size: 4242, mtimeMs: 1700000000000 });
    await store.save();

    const record = (await readMarks([file])).get(file)!;
    expect(record.size).toBe(4242);
    expect(record.mtimeMs).toBe(1700000000000);
  });

  test('records the given tripwire even for a file that is gone', async () => {
    // The batch commands hand over what the scan saw; a frame relocated between
    // the scan and the marking pass must not lose its size and mtime to that.
    const gone = path.join(catalog, 'gone.cr3');
    const store = await TriageStore.open(catalog);
    await store.mark(gone, { reject: true }, 'cull', { tool: 'cull@test' }, { size: 99, mtimeMs: 5 });
    await store.save();

    const record = (await readMarks([gone])).get(gone)!;
    expect(record.size).toBe(99);
    expect(record.mtimeMs).toBe(5);
  });

  test('still records a mark for a file that has already vanished', async () => {
    const gone = path.join(catalog, 'gone.cr3');
    await markOne(catalog, gone, { reject: true });
    const record = (await readMarks([gone])).get(gone)!;
    expect(record.size).toBe(0);
    expect(record.mtimeMs).toBe(0);
  });

  test('keys on the resolved path, so a relative spelling finds the same record', async () => {
    const file = await photo('IMG_1.cr3');
    await markOne(catalog, path.join(catalog, '.', 'IMG_1.cr3'), { reject: true });
    expect((await readMarks([file])).size).toBe(1);
  });

  test('re-marking rewrites the record rather than appending a duplicate', async () => {
    const file = await photo('IMG_1.cr3');
    await markOne(catalog, file, { stars: 1 });
    await markOne(catalog, file, { stars: 5 });

    const store = await TriageStore.open(catalog);
    expect(store.size).toBe(1);
    expect((await readMarks([file])).get(file)!.marks.stars).toBe(5);
  });

  test('writes nothing at all when there is nothing to write', async () => {
    const store = await TriageStore.open(catalog);
    await store.save();
    expect(existsSync(store.storePath)).toBe(false);
  });
});

describe('readMarks', () => {
  test('crosses every shoot file, whichever folder was culled', async () => {
    const day1 = await photo(path.join('day1', 'IMG_1.cr3'));
    const day2 = await photo(path.join('day2', 'IMG_2.cr3'));
    await markOne(path.join(catalog, 'day1'), day1, { reject: true });
    await markOne(path.join(catalog, 'day2'), day2, { stars: 5 });

    // Developing the parent folder must still find both.
    const found = await readMarks([day1, day2]);
    expect(found.size).toBe(2);
  });

  test('omits files that carry no mark', async () => {
    const marked = await photo('IMG_1.cr3');
    const bare = await photo('IMG_2.cr3');
    await markOne(catalog, marked, { reject: true });

    const found = await readMarks([marked, bare]);
    expect([...found.keys()]).toEqual([marked]);
  });

  test('is empty when nothing has been marked on this machine', async () => {
    expect((await readMarks([path.join(catalog, 'x.cr3')])).size).toBe(0);
  });
});

describe('countPendingUnder', () => {
  test('counts what is still owed a sidecar beneath a folder', async () => {
    const a = await photo(path.join('day1', 'IMG_1.cr3'));
    const b = await photo(path.join('day2', 'IMG_2.cr3'));
    await markOne(catalog, a, { reject: true });
    await markOne(catalog, b, { stars: 5 });

    expect(await countPendingUnder(catalog, xmpFor)).toBe(2);
    expect(await countPendingUnder(path.join(catalog, 'day1'), xmpFor)).toBe(1);
  });

  test('stops counting once the mark has reached its sidecar', async () => {
    const file = await photo('IMG_1.cr3');
    await markOne(catalog, file, { reject: true });
    await consumeMarks(new Map([[file, xmpFor(file)]]));
    expect(await countPendingUnder(catalog, xmpFor)).toBe(0);
  });

  // Self-healing: a run that wrote somewhere else never reached this photograph.
  test('still counts a mark applied to a different sidecar', async () => {
    const file = await photo('IMG_1.cr3');
    await markOne(catalog, file, { reject: true });
    await consumeMarks(new Map([[file, path.join(catalog, 'elsewhere.xmp')]]));
    expect(await countPendingUnder(catalog, xmpFor)).toBe(1);
  });

  test('asks the caller which sidecar, because a second editor spells it differently', async () => {
    const file = await photo('IMG_1.cr3');
    await markOne(catalog, file, { reject: true });
    const rrdata = (f: string): string => `${f}.rrdata`;
    await consumeMarks(new Map([[file, rrdata(file)]]));

    expect(await countPendingUnder(catalog, rrdata)).toBe(0);
    expect(await countPendingUnder(catalog, xmpFor)).toBe(1);
  });

  test('does not count a sibling folder that merely shares a prefix', async () => {
    const inside = await photo(path.join('day1', 'IMG_1.cr3'));
    const sibling = await photo(path.join('day10', 'IMG_2.cr3'));
    await markOne(catalog, inside, { reject: true });
    await markOne(catalog, sibling, { reject: true });

    expect(await countPendingUnder(path.join(catalog, 'day1'), xmpFor)).toBe(1);
  });

  test('is zero for a folder nobody has marked', async () => {
    expect(await countPendingUnder(catalog, xmpFor)).toBe(0);
  });
});

describe('moveMarks', () => {
  const one = (from: string, to: string): Map<string, string> => new Map([[from, to]]);

  test('follows a file that was relocated', async () => {
    const from = await photo('IMG_1.cr3');
    const to = path.join(catalog, 'keep', 'IMG_1.cr3');
    await markOne(catalog, from, { reject: true });

    expect(await moveMarks(one(from, to))).toBe(1);
    expect((await readMarks([from])).size).toBe(0);
    expect((await readMarks([to])).get(to)!.marks).toEqual({ reject: true });
  });

  test('rewrites the record\'s own idea of where it lives', async () => {
    const from = await photo('IMG_1.cr3');
    const to = path.join(catalog, 'IMG_9.cr3');
    await markOne(catalog, from, { stars: 3 });
    await moveMarks(one(from, to));
    expect((await readMarks([to])).get(to)!.file).toBe(to);
  });

  test('does nothing for a file that carried no marks', async () => {
    expect(await moveMarks(one(path.join(catalog, 'a.cr3'), path.join(catalog, 'b.cr3')))).toBe(0);
  });

  test('is a no-op when the path did not actually change', async () => {
    const file = await photo('IMG_1.cr3');
    await markOne(catalog, file, { reject: true });
    expect(await moveMarks(one(file, path.join(catalog, '.', 'IMG_1.cr3')))).toBe(0);
    expect((await readMarks([file])).size).toBe(1);
  });

  test('follows a whole batch in one pass', async () => {
    // What a rename does: every file in the shoot changes name at once. The
    // point is that they all arrive, whatever order the stores are read in.
    const files = await Promise.all(['a.cr3', 'b.cr3', 'c.cr3'].map((n) => photo(n)));
    for (const f of files) await markOne(catalog, f, { stars: 2 });
    const moves = new Map(files.map((f) => [f, path.join(catalog, `renamed_${path.basename(f)}`)]));

    expect(await moveMarks(moves)).toBe(3);
    expect((await readMarks(files)).size).toBe(0);
    for (const to of moves.values()) {
      expect((await readMarks([to])).get(to)!.marks).toEqual({ stars: 2 });
    }
  });

  test('follows marks that live in different shoots', async () => {
    // Two shoots are two store files, and a batch spanning both has to visit
    // both — an early return after the first hit would strand the second.
    const day1 = await photo('day1/IMG_1.cr3');
    const day2 = await photo('day2/IMG_2.cr3');
    await markOne(path.join(catalog, 'day1'), day1, { reject: true });
    await markOne(path.join(catalog, 'day2'), day2, { stars: 5 });

    const moves = new Map([
      [day1, path.join(catalog, 'day1', 'moved_1.cr3')],
      [day2, path.join(catalog, 'day2', 'moved_2.cr3')],
    ]);
    expect(await moveMarks(moves)).toBe(2);
    for (const [, to] of moves) expect((await readMarks([to])).has(to)).toBe(true);
  });

  test('moves only what it was given, leaving the rest of the shoot alone', async () => {
    const stays = await photo('stays.cr3');
    const goes = await photo('goes.cr3');
    await markOne(catalog, stays, { stars: 1 });
    await markOne(catalog, goes, { stars: 4 });

    const to = path.join(catalog, 'gone.cr3');
    expect(await moveMarks(one(goes, to))).toBe(1);
    expect((await readMarks([stays])).get(stays)!.marks).toEqual({ stars: 1 });
    expect((await readMarks([to])).get(to)!.marks).toEqual({ stars: 4 });
  });

  test('accepts an empty batch', async () => {
    expect(await moveMarks(new Map())).toBe(0);
  });
});

describe('consumeMarks', () => {
  test('records where the marks went instead of deleting them', async () => {
    const file = await photo('IMG_1.cr3');
    await markOne(catalog, file, { reject: true });

    expect(await consumeMarks(new Map([[file, xmpFor(file)]]))).toBe(1);
    const record = (await readMarks([file])).get(file)!;
    expect(record.applied!.sidecar).toBe(xmpFor(file));
    expect(record.marks).toEqual({ reject: true });
  });

  test('ignores a file it holds no record for', async () => {
    expect(await consumeMarks(new Map([[path.join(catalog, 'ghost.cr3'), 'x.xmp']]))).toBe(0);
  });

  test('does nothing for an empty batch', async () => {
    expect(await consumeMarks(new Map())).toBe(0);
  });
});

describe('purgeMarks', () => {
  test('drops what already reached a sidecar', async () => {
    const applied = await photo('IMG_1.cr3');
    const pending = await photo('IMG_2.cr3');
    await markOne(catalog, applied, { reject: true });
    await markOne(catalog, pending, { stars: 5 });
    await consumeMarks(new Map([[applied, xmpFor(applied)]]));

    expect(await purgeMarks()).toEqual({ applied: 1, orphaned: 0 });
    expect((await readMarks([applied, pending])).size).toBe(1);
  });

  test('keeps a pending mark whose photograph has gone, unless asked', async () => {
    const gone = path.join(catalog, 'gone.cr3');
    await markOne(catalog, gone, { reject: true });

    expect(await purgeMarks()).toEqual({ applied: 0, orphaned: 0 });
    expect(await purgeMarks({ orphans: true })).toEqual({ applied: 0, orphaned: 1 });
    expect((await readMarks([gone])).size).toBe(0);
  });

  test('counts without writing under dryRun', async () => {
    const file = await photo('IMG_1.cr3');
    await markOne(catalog, file, { reject: true });
    await consumeMarks(new Map([[file, xmpFor(file)]]));

    expect(await purgeMarks({ dryRun: true })).toEqual({ applied: 1, orphaned: 0 });
    expect((await readMarks([file])).size).toBe(1);
  });

  test('removes a store file that has nothing left in it', async () => {
    const file = await photo('IMG_1.cr3');
    await markOne(catalog, file, { reject: true });
    await consumeMarks(new Map([[file, xmpFor(file)]]));
    await purgeMarks();

    expect(existsSync(storePathFor(catalog))).toBe(false);
  });
});

describe('readAllMarks', () => {
  test('groups every record by the store file holding it', async () => {
    const day1 = await photo(path.join('day1', 'IMG_1.cr3'));
    const day2 = await photo(path.join('day2', 'IMG_2.cr3'));
    await markOne(path.join(catalog, 'day1'), day1, { reject: true });
    await markOne(path.join(catalog, 'day2'), day2, { stars: 5 });

    const all = await readAllMarks();
    expect(all.size).toBe(2);
    expect([...all.values()].reduce((n, m) => n + m.size, 0)).toBe(2);
  });

  test('is empty on a machine that has never marked anything', async () => {
    expect((await readAllMarks()).size).toBe(0);
  });
});
