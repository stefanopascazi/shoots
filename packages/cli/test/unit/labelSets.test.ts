/**
 * Semantic label → the string an editor recognizes.
 *
 * The override file is hand-edited, so the failure modes tested here are the
 * ones a human produces: a BOM from Notepad, a typo'd key, an empty value.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { builtinLabelSet, LabelSetError, resolveLabelSet } from '../../src/triage/labelSets.js';
import { SEMANTIC_LABELS } from '../../src/triage/schema.js';

let home: string;
let saved: string | undefined;

const writeOverride = async (editorId: string, body: string): Promise<void> => {
  const dir = path.join(home, 'labels');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${editorId}.json`), body);
};

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'shoots-labels-'));
  saved = process.env.SHOOTS_HOME;
  process.env.SHOOTS_HOME = home;
});

afterEach(async () => {
  if (saved === undefined) delete process.env.SHOOTS_HOME;
  else process.env.SHOOTS_HOME = saved;
  await rm(home, { recursive: true, force: true });
});

describe('builtinLabelSet', () => {
  test('gives Adobe the capitalized English names Lightroom matches', () => {
    expect(builtinLabelSet('acr')).toEqual({
      reject: 'Red',
      select: 'Green',
      review: 'Yellow',
      'second-pass': 'Purple',
    });
  });

  test('gives RapidRAW its lowercase enum', () => {
    expect(builtinLabelSet('rapidraw')).toEqual({
      reject: 'red',
      select: 'green',
      review: 'yellow',
      'second-pass': 'purple',
    });
  });

  test('falls back to the Adobe set for an editor with no opinion', () => {
    expect(builtinLabelSet('darktable')).toEqual(builtinLabelSet('acr'));
    expect(builtinLabelSet('')).toEqual(builtinLabelSet('acr'));
  });

  test('covers every semantic label, so no mark is unmappable', () => {
    for (const editor of ['acr', 'rapidraw', 'unknown']) {
      const set = builtinLabelSet(editor);
      for (const label of SEMANTIC_LABELS) expect(typeof set[label]).toBe('string');
    }
  });
});

describe('resolveLabelSet', () => {
  test('returns the built-in set when there is no override', async () => {
    expect(await resolveLabelSet('acr')).toEqual(builtinLabelSet('acr'));
  });

  test('merges a partial override over the defaults', async () => {
    await writeOverride('acr', JSON.stringify({ reject: 'Rosso' }));
    expect(await resolveLabelSet('acr')).toEqual({
      reject: 'Rosso',
      select: 'Green',
      review: 'Yellow',
      'second-pass': 'Purple',
    });
  });

  test('accepts a file saved with a UTF-8 BOM, as Notepad writes it', async () => {
    await writeOverride('acr', '﻿' + JSON.stringify({ select: 'Verde' }));
    expect((await resolveLabelSet('acr')).select).toBe('Verde');
  });

  test('keeps the override scoped to its own editor', async () => {
    await writeOverride('acr', JSON.stringify({ reject: 'Rosso' }));
    expect((await resolveLabelSet('rapidraw')).reject).toBe('red');
  });

  test('rejects malformed JSON, naming the file', async () => {
    await writeOverride('acr', '{ nope');
    expect(resolveLabelSet('acr')).rejects.toThrow(LabelSetError);
    expect(resolveLabelSet('acr')).rejects.toThrow(/is not valid JSON/);
  });

  test('rejects a document that is not an object', async () => {
    await writeOverride('acr', '["Red"]');
    expect(resolveLabelSet('acr')).rejects.toThrow(/must be an object mapping/);
  });

  test('rejects an unknown label rather than silently ignoring it', async () => {
    await writeOverride('acr', JSON.stringify({ rejected: 'Red' }));
    expect(resolveLabelSet('acr')).rejects.toThrow(/unknown label 'rejected'/);
  });

  test('rejects an empty or non-string value', async () => {
    await writeOverride('acr', JSON.stringify({ reject: '   ' }));
    expect(resolveLabelSet('acr')).rejects.toThrow(/must be a non-empty string/);

    await writeOverride('rapidraw', JSON.stringify({ reject: 3 }));
    expect(resolveLabelSet('rapidraw')).rejects.toThrow(/must be a non-empty string/);
  });
});
