import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { developShootDir, developShootsDir } from '@shoots/core';
import { foldRunIntoShoot, shootWorkDir } from '../../src/develop/shoot.js';
import { loadDataset } from '../../src/develop/dataset/load.js';

let home: string;
const previous = process.env.SHOOTS_HOME;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'shoots-shoot-'));
  process.env.SHOOTS_HOME = home;
});

afterEach(() => {
  if (previous === undefined) delete process.env.SHOOTS_HOME;
  else process.env.SHOOTS_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});

describe('shootWorkDir', () => {
  test('two folders with one name get two directories', () => {
    const a = shootWorkDir('/photos/2025/Selects', 'linux');
    const b = shootWorkDir('/photos/2026/Selects', 'linux');
    expect(a).not.toBe(b);
    expect(path.dirname(a)).toBe(developShootsDir());
    expect(path.basename(a)).toMatch(/^Selects-[0-9a-f]{8}$/);
  });

  test('on Windows the spelling of the case does not matter', () => {
    // The name keeps its case (NTFS ignores it); the digest, which tells shoots apart, is the same.
    const dir = (p: string) => path.basename(shootWorkDir(p, 'win32')).toLowerCase();
    expect(dir('C:\\Photos\\Rome')).toBe(dir('c:\\photos\\ROME'));
  });

  test('a shoot started under the old name keeps it', () => {
    mkdirSync(developShootDir('Rome'), { recursive: true });
    expect(shootWorkDir('/photos/Rome', 'linux')).toBe(developShootDir('Rome'));
  });
});

describe('foldRunIntoShoot', () => {
  const meta = (baseline = 'external') =>
    JSON.stringify({ _type: 'develop-meta', command: 'develop-export', model: 'm', dim: 2, colorFeatureNames: [], colorDim: 1, baseline });
  const record = (file: string, x: number) => JSON.stringify({ file, embedding: [x, x], features: [x], develop: {}, edited: false });
  const prediction = (at: string, files: string[]) =>
    JSON.stringify({ command: 'develop-predict', at, profile: 'p', count: files.length, predictions: files.map((file) => ({ file, treatment: 'color', develop: {} })) });

  function run(dir: string, at: string, files: string[], baseline?: string): [string, string] {
    const data = path.join(dir, 'run.export.jsonl');
    const pred = path.join(dir, 'run.prediction.json');
    writeFileSync(data, [...files.map((f, i) => record(f, i)), meta(baseline)].join('\n') + '\n');
    writeFileSync(pred, prediction(at, files));
    return [data, pred];
  }

  test('a second run keeps the first run’s photos, each with its own instant', async () => {
    const dir = path.join(home, 'shoot');
    mkdirSync(dir);
    await foldRunIntoShoot(dir, ...run(dir, '2026-10-01T00:00:00Z', ['/s/a.CR3', '/s/b.CR3']));
    await foldRunIntoShoot(dir, ...run(dir, '2026-10-02T00:00:00Z', ['/s/b.CR3', '/s/c.CR3']));

    const data = await loadDataset(path.join(dir, 'export.jsonl'));
    expect(data.results.map((r) => r.file).sort()).toEqual(['/s/a.CR3', '/s/b.CR3', '/s/c.CR3']);
    const pred = JSON.parse(readFileSync(path.join(dir, 'prediction.json'), 'utf8'));
    const at = Object.fromEntries(pred.predictions.map((p: { file: string; predictedAt: string }) => [p.file, p.predictedAt]));
    expect(at).toEqual({ '/s/a.CR3': '2026-10-01T00:00:00Z', '/s/b.CR3': '2026-10-02T00:00:00Z', '/s/c.CR3': '2026-10-02T00:00:00Z' });
    expect(pred.count).toBe(3);
  });

  test('a run in another feature space replaces what was there', async () => {
    const dir = path.join(home, 'shoot');
    mkdirSync(dir);
    await foldRunIntoShoot(dir, ...run(dir, '2026-10-01T00:00:00Z', ['/s/a.CR3'], 'embedded-preview'));
    await foldRunIntoShoot(dir, ...run(dir, '2026-10-02T00:00:00Z', ['/s/b.CR3']));
    const data = await loadDataset(path.join(dir, 'export.jsonl'));
    expect(data.results.map((r) => r.file)).toEqual(['/s/b.CR3']);
    expect(JSON.parse(readFileSync(path.join(dir, 'prediction.json'), 'utf8')).predictions).toHaveLength(1);
  });
});
