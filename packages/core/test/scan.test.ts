/** File discovery: what the whole CLI considers "the shoot". */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyExtension, scanFiles, PROCESSED_EXTENSIONS, RAW_EXTENSIONS } from '../src/fs/scan.js';

let root: string;

const touch = async (rel: string): Promise<string> => {
  const full = path.join(root, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, 'x');
  return full;
};

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'shoots-scan-'));
  await touch('a.CR3');
  await touch('b.jpg');
  await touch('notes.txt');
  await touch('.hidden.jpg');
  await touch(path.join('sub', 'c.arw'));
  await touch(path.join('sub', 'd.png'));
  await touch(path.join('.hiddendir', 'e.jpg'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('classifyExtension', () => {
  test('splits raw from processed and rejects everything else', () => {
    expect(classifyExtension('cr3')).toBe('raw');
    expect(classifyExtension('nef')).toBe('raw');
    expect(classifyExtension('jpg')).toBe('processed');
    expect(classifyExtension('webp')).toBe('processed');
    expect(classifyExtension('txt')).toBeNull();
    expect(classifyExtension('')).toBeNull();
  });

  test('expects a lowercase extension without the dot', () => {
    expect(classifyExtension('CR3')).toBeNull();
    expect(classifyExtension('.cr3')).toBeNull();
  });

  test('keeps the two allow-lists disjoint', () => {
    for (const ext of RAW_EXTENSIONS) expect(PROCESSED_EXTENSIONS.has(ext)).toBe(false);
  });
});

describe('scanFiles', () => {
  test('walks recursively, lowercases extensions and sorts by path', async () => {
    const found = await scanFiles(root);
    const names = found.map((f) => f.name);

    expect(names).toEqual(['a.CR3', 'b.jpg', 'c.arw', 'd.png']);
    expect(found.find((f) => f.name === 'a.CR3')!.ext).toBe('cr3');
    expect(found.map((f) => f.path)).toEqual([...found.map((f) => f.path)].sort((a, b) => a.localeCompare(b)));
  });

  test('skips non-images and every dot-prefixed entry, files and directories alike', async () => {
    const names = (await scanFiles(root)).map((f) => f.name);
    expect(names).not.toContain('notes.txt');
    expect(names).not.toContain('.hidden.jpg');
    expect(names).not.toContain('e.jpg');
  });

  test('stays in the top directory when recursion is off', async () => {
    const names = (await scanFiles(root, { recursive: false })).map((f) => f.name);
    expect(names).toEqual(['a.CR3', 'b.jpg']);
  });

  test('filters by kind', async () => {
    const raws = await scanFiles(root, { kinds: ['raw'] });
    expect(raws.map((f) => f.name)).toEqual(['a.CR3', 'c.arw']);
    expect(raws.every((f) => f.kind === 'raw')).toBe(true);

    const processed = await scanFiles(root, { kinds: ['processed'] });
    expect(processed.map((f) => f.name)).toEqual(['b.jpg', 'd.png']);
  });

  test('an explicit extension list overrides the allow-list entirely', async () => {
    const only = await scanFiles(root, { extensions: ['JPG'] });
    expect(only.map((f) => f.name)).toEqual(['b.jpg']);
  });

  test('accepts a single file as the root', async () => {
    const one = await scanFiles(path.join(root, 'b.jpg'));
    expect(one.length).toBe(1);
    expect(one[0]!.name).toBe('b.jpg');
    expect(path.isAbsolute(one[0]!.path)).toBe(true);
  });

  test('reports size and mtime for each match', async () => {
    const [first] = await scanFiles(root);
    expect(first!.size).toBe(1);
    expect(first!.mtime).toBeInstanceOf(Date);
  });

  test('calls onProgress once per match with a running count', async () => {
    const counts: number[] = [];
    const found = await scanFiles(root, { onProgress: (n) => counts.push(n) });
    expect(counts).toEqual(Array.from({ length: found.length }, (_, i) => i + 1));
  });

  test('rejects when the root does not exist', async () => {
    expect(scanFiles(path.join(root, 'missing'))).rejects.toThrow();
  });

  test('a single-file root that is not an image comes back empty', async () => {
    expect(await scanFiles(path.join(root, 'notes.txt'))).toEqual([]);
  });
});

/**
 * The scan reads directories several at a time and asks for metadata several at
 * a time, which is what makes it bearable on a network share. Neither may lose a
 * file, however the pool happens to schedule them.
 */
describe('scanFiles under concurrency', () => {
  let deep: string;

  beforeAll(async () => {
    deep = await mkdtemp(path.join(tmpdir(), 'shoots-scan-deep-'));
    // A flat folder wider than any sensible pool, so the metadata pass has to
    // queue rather than fire everything at once.
    for (let i = 0; i < 250; i++) {
      await writeFile(path.join(deep, `flat_${String(i).padStart(3, '0')}.jpg`), 'x');
    }
    // And a chain deeper than the pool is wide: bounding per level rather than
    // globally would either deadlock this or blow the ceiling wide open.
    let nested = deep;
    for (let level = 0; level < 40; level++) {
      nested = path.join(nested, `level_${level}`);
      await mkdir(nested, { recursive: true });
      await writeFile(path.join(nested, `deep_${level}.cr3`), 'x');
    }
  });

  afterAll(async () => {
    await rm(deep, { recursive: true, force: true });
  });

  test('finds every file in a wide flat folder', async () => {
    const found = await scanFiles(deep, { recursive: false });
    expect(found).toHaveLength(250);
    expect(found.every((f) => f.size === 1)).toBe(true);
  });

  test('reaches the bottom of a chain deeper than the pool is wide', async () => {
    const found = await scanFiles(deep, { extensions: ['cr3'] });
    expect(found).toHaveLength(40);
    expect(found.map((f) => f.name)).toContain('deep_39.cr3');
  });

  test('answers the same however many requests are allowed in flight', async () => {
    const serial = await scanFiles(deep, { concurrency: 1 });
    const parallel = await scanFiles(deep, { concurrency: 64 });
    expect(parallel.map((f) => f.path)).toEqual(serial.map((f) => f.path));
    expect(parallel).toHaveLength(290);
  });

  test('counts every match exactly once, whatever order the pool visits them in', async () => {
    const counts: number[] = [];
    const found = await scanFiles(deep, { onProgress: (n) => counts.push(n) });
    expect(counts).toEqual(Array.from({ length: found.length }, (_, i) => i + 1));
  });
});
