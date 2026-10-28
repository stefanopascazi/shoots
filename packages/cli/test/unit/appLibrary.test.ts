import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { browse, fsRoots, isHiddenDir, Library } from '../../src/app/library.js';

let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'shoots-lib-'));
  mkdirSync(path.join(root, 'day 2'));
  mkdirSync(path.join(root, 'day 10'));
  mkdirSync(path.join(root, '.cache'));
  writeFileSync(path.join(root, 'a.jpg'), 'x');
  writeFileSync(path.join(root, 'b.CR3'), 'x');
  writeFileSync(path.join(root, 'notes.txt'), 'x');
  writeFileSync(path.join(root, 'day 2', 'c.jpg'), 'x');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('browse', () => {
  test('lists visible subfolders in natural order and counts images', async () => {
    const r = await browse(root);
    expect(r.dirs.map((d) => d.name)).toEqual(['day 2', 'day 10']);
    expect(r.images).toBe(2);
    expect(r.parent).toBe(path.dirname(root));
  });

  test('null lists the roots', async () => {
    const r = await browse(null);
    expect(r.path).toBeNull();
    expect(r.dirs.length).toBeGreaterThan(0);
  });

  test('roots outside Windows are /', () => {
    expect(fsRoots('linux')).toEqual(['/']);
  });

  test('hidden folders', () => {
    expect(isHiddenDir('.git')).toBe(true);
    expect(isHiddenDir('$RECYCLE.BIN')).toBe(true);
    expect(isHiddenDir('2025')).toBe(false);
  });
});

describe('Library', () => {
  test('lists photos, recursively only on request', async () => {
    const lib = new Library();
    expect((await lib.list(root, false)).photos.map((p) => p.name)).toEqual(['a.jpg', 'b.CR3']);
    expect((await lib.list(root, true)).photos).toHaveLength(3);
  });

  test('serves only images inside a listed folder', async () => {
    const lib = new Library();
    expect(lib.isServable(path.join(root, 'a.jpg'))).toBe(false);
    await lib.list(root, false);
    expect(lib.isServable(path.join(root, 'a.jpg'))).toBe(true);
    expect(lib.isServable(path.join(root, 'notes.txt'))).toBe(false);
    expect(lib.isServable(path.join(root, 'day 2', 'c.jpg'))).toBe(false);
    expect(lib.isServable(path.join(root, '..', 'elsewhere.jpg'))).toBe(false);
    await lib.list(root, true);
    expect(lib.isServable(path.join(root, 'day 2', 'c.jpg'))).toBe(true);
  });

  test('a file is not a folder', async () => {
    await expect(new Library().list(path.join(root, 'a.jpg'), false)).rejects.toThrow('not a folder');
  });
});
