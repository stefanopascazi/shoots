/**
 * Target resolution: a folder to scan, or the explicit list a host editor's
 * selection hands over. The list path is what the Lightroom plugin depends on.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveTargets, skippedAsError } from '../../src/targets.js';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'shoots-targets-'));
  await writeFile(path.join(root, 'a.jpg'), 'x');
  await writeFile(path.join(root, 'b.jpg'), 'x');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('resolveTargets', () => {
  test('refuses both a path and a list, and neither', async () => {
    expect((await resolveTargets(root, 'list.txt')).ok).toBe(false);
    expect((await resolveTargets(undefined, undefined)).ok).toBe(false);
  });

  test('a folder scans every image under it', async () => {
    const r = await resolveTargets(root, undefined);
    if (!r.ok) throw new Error(r.error);
    expect(r.targets.fromList).toBe(false);
    expect(r.targets.files.map((f) => f.name)).toEqual(['a.jpg', 'b.jpg']);
  });

  test('a list takes exactly the files it names and reports the rest', async () => {
    const list = path.join(root, 'list.txt');
    const missing = path.join(root, 'gone.jpg');
    await writeFile(list, `${path.join(root, 'b.jpg')}\n${missing}\n`);
    const r = await resolveTargets(undefined, list);
    if (!r.ok) throw new Error(r.error);
    expect(r.targets.fromList).toBe(true);
    expect(r.targets.files.map((f) => f.name)).toEqual(['b.jpg']);
    expect(r.targets.skipped.map(skippedAsError)).toEqual([{ file: missing, error: 'file not found' }]);
  });

  test('an unreadable list is an error, not an empty run', async () => {
    const r = await resolveTargets(undefined, path.join(root, 'nope.txt'));
    expect(r.ok).toBe(false);
  });
});
