import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { developExportPath, developFeedbackPath, developProfilePath, developShootsDir } from '@shoots/core';
import { cleanEntries, runClean, selectedParts } from '../../src/develop/commands/clean.js';

let home: string;
const previous = process.env.SHOOTS_HOME;

function put(file: string, text = 'x'): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'shoots-clean-'));
  process.env.SHOOTS_HOME = home;
  put(developExportPath());
  put(developProfilePath(), JSON.stringify({ name: 'p', calibration: { at: 'x' } }));
  put(developFeedbackPath());
  put(path.join(developShootsDir(), '2026-10-01', 'export.jsonl'));
});

afterEach(() => {
  if (previous === undefined) delete process.env.SHOOTS_HOME;
  else process.env.SHOOTS_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});

/** Runs the command quietly, returning its --json report. */
async function clean(only: string): Promise<{ removed: Array<{ part: string }> }> {
  const out: string[] = [];
  const write = spyOn(process.stdout, 'write').mockImplementation(((c: string) => (out.push(String(c)), true)) as never);
  try {
    await runClean({ only, json: true });
  } finally {
    write.mockRestore();
  }
  return JSON.parse(out.join(''));
}

describe('selectedParts', () => {
  test('the defaults: shoots, and --all adds dataset and profile; never the journal', () => {
    expect([...selectedParts({})]).toEqual(['shoots']);
    expect([...selectedParts({ all: true })].sort()).toEqual(['dataset', 'profile', 'shoots']);
  });

  test('--only names exactly what goes, and refuses unknown names', () => {
    expect([...selectedParts({ only: 'journal, calibration', all: true })].sort()).toEqual(['calibration', 'journal']);
    expect(() => selectedParts({ only: 'cache' })).toThrow("unknown part 'cache'");
  });
});

describe('develop clean --only', () => {
  test('the journal goes only when named', async () => {
    await clean('shoots,dataset,profile');
    expect(existsSync(developFeedbackPath())).toBe(true);
    expect(existsSync(developExportPath())).toBe(false);
    expect(existsSync(developProfilePath())).toBe(false);
    expect(existsSync(developShootsDir() + '/2026-10-01')).toBe(false);

    await clean('journal');
    expect(existsSync(developFeedbackPath())).toBe(false);
  });

  test('calibration strips the profile and keeps the fit', async () => {
    const report = await clean('calibration');
    expect(report.removed.map((r) => r.part)).toEqual(['calibration']);
    expect(JSON.parse(readFileSync(developProfilePath(), 'utf8'))).toEqual({ name: 'p' });
    // Nothing left to strip the second time.
    expect((await cleanEntries(new Set(['calibration']))).length).toBe(0);
  });

  test('calibration is skipped when the profile goes anyway', async () => {
    const entries = await cleanEntries(new Set(['profile', 'calibration']));
    expect(entries.map((e) => e.part)).toEqual(['profile']);
  });
});
