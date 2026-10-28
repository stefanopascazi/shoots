/**
 * The progress file a host polls while the CLI runs. What matters: one JSON
 * object per line, every percent and phase change present, ticks collapsed.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createProgressChannel, markExitOnProgressFile } from '../../src/progressChannel.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'shoots-progress-'));
  file = path.join(dir, 'progress.jsonl');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const lines = async (): Promise<unknown[]> =>
  (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));

describe('createProgressChannel', () => {
  test('no file, no writes', () => {
    expect(() => createProgressChannel(undefined).emit({ kind: 'phase', label: 'Scanning' })).not.toThrow();
  });

  test('steps collapse to one line per percent', async () => {
    const ch = createProgressChannel(file);
    for (let i = 0; i <= 1000; i++) ch.emit({ kind: 'steps', label: 'Rating', done: i, total: 1000 });
    const out = (await lines()) as { done: number }[];
    expect(out).toHaveLength(101);
    expect(out.at(-1)).toEqual({ kind: 'steps', label: 'Rating', done: 1000, total: 1000 });
  });

  test('a phase detail is throttled, a new phase label is not', async () => {
    let t = 0;
    const ch = createProgressChannel(file, () => t);
    ch.emit({ kind: 'phase', label: 'Scanning' });
    ch.emit({ kind: 'phase', label: 'Scanning', detail: '1 files' });
    t = 500;
    ch.emit({ kind: 'phase', label: 'Scanning', detail: '9 files' });
    ch.emit({ kind: 'phase', label: 'Loading model' });
    expect(await lines()).toEqual([
      { kind: 'phase', label: 'Scanning' },
      { kind: 'phase', label: 'Scanning', detail: '9 files' },
      { kind: 'phase', label: 'Loading model' },
    ]);
  });

  test('a download of unknown size is still reported', async () => {
    const ch = createProgressChannel(file);
    ch.emit({ kind: 'download', label: 'exiftool', received: 10, total: null });
    expect(await lines()).toEqual([{ kind: 'download', label: 'exiftool', received: 10, total: null }]);
  });

  test('an unwritable file never throws', () => {
    const ch = createProgressChannel(path.join(dir, 'missing', 'deeper', 'p.jsonl'));
    expect(() => ch.emit({ kind: 'phase', label: 'x' })).not.toThrow();
  });
});

describe('markExitOnProgressFile', () => {
  test('the file ends with the exit code', async () => {
    const module = path.resolve(import.meta.dir, '../../src/progressChannel.ts');
    const script = `const { markExitOnProgressFile } = await import(${JSON.stringify(module)}); markExitOnProgressFile(${JSON.stringify(file)}); process.exitCode = 3;`;
    const run = spawnSync(process.execPath, ['-e', script]);
    expect(run.status).toBe(3);
    expect(await lines()).toEqual([{ kind: 'exit', code: 3 }]);
  });
});
