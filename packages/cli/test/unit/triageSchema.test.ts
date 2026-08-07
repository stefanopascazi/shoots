/**
 * The canonical triage vocabulary and its JSONL line format.
 *
 * `parseRecord` is deliberately lenient: the store is append-only, and a line
 * truncated by a crash must cost one mark, not the whole shoot.
 */
import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  isPending,
  isSemanticLabel,
  mergeMarks,
  needsApplying,
  parseRecord,
  sameSidecar,
  SEMANTIC_LABELS,
  type TriageRecord,
} from '../../src/triage/schema.js';

const record = (over: Partial<TriageRecord> = {}): TriageRecord => ({
  file: path.resolve('/photos/a.cr3'),
  size: 100,
  mtimeMs: 1700000000000,
  marks: {},
  sources: {},
  ...over,
});

describe('isSemanticLabel', () => {
  test('accepts every label in the vocabulary', () => {
    for (const label of SEMANTIC_LABELS) expect(isSemanticLabel(label)).toBe(true);
  });

  test('rejects an editor colour — presentation is not meaning', () => {
    expect(isSemanticLabel('Red')).toBe(false);
    expect(isSemanticLabel('red')).toBe(false);
    expect(isSemanticLabel('')).toBe(false);
  });
});

describe('mergeMarks', () => {
  test('lets a later producer win field by field', () => {
    expect(mergeMarks({ stars: 3, reject: true }, { stars: 5 })).toEqual({ stars: 5, reject: true });
  });

  test('ignores undefined, so `rate` cannot erase what `cull` decided', () => {
    expect(mergeMarks({ reject: true }, { reject: undefined, stars: 4 })).toEqual({
      reject: true,
      stars: 4,
    });
  });

  test('keeps an explicit false or zero, which is a decision', () => {
    expect(mergeMarks({ reject: true, stars: 5 }, { reject: false, stars: 0 })).toEqual({
      reject: false,
      stars: 0,
    });
  });

  test('does not mutate either argument', () => {
    const base = { stars: 1 };
    const incoming = { stars: 2 };
    mergeMarks(base, incoming);
    expect(base).toEqual({ stars: 1 });
    expect(incoming).toEqual({ stars: 2 });
  });

  test('replaces keywords wholesale rather than concatenating', () => {
    expect(mergeMarks({ keywords: ['a'] }, { keywords: ['b'] }).keywords).toEqual(['b']);
  });
});

describe('isPending', () => {
  test('is true until the marks reach a sidecar', () => {
    expect(isPending(record())).toBe(true);
    expect(isPending(record({ applied: { at: 'now', sidecar: '/x.xmp' } }))).toBe(false);
  });
});

describe('sameSidecar', () => {
  test('normalizes both paths before comparing', () => {
    expect(sameSidecar('/a/b/../b/c.xmp', '/a/b/c.xmp')).toBe(true);
  });

  test('distinguishes genuinely different sidecars', () => {
    expect(sameSidecar('/a/c.xmp', '/b/c.xmp')).toBe(false);
  });

  test('is case-insensitive on Windows only', () => {
    const same = sameSidecar('/A/C.XMP', '/a/c.xmp');
    expect(same).toBe(process.platform === 'win32');
  });
});

describe('needsApplying', () => {
  test('a never-applied record is always owed a write', () => {
    expect(needsApplying(record(), '/anywhere.xmp')).toBe(true);
  });

  test('a record applied to this very sidecar is done', () => {
    const applied = record({ applied: { at: 'now', sidecar: path.resolve('/photos/a.xmp') } });
    expect(needsApplying(applied, path.resolve('/photos/a.xmp'))).toBe(false);
  });

  // The self-healing property: a run that wrote to the wrong place left the
  // photograph without its mark, and the next pass has to notice.
  test('a record applied elsewhere still owes this sidecar', () => {
    const applied = record({ applied: { at: 'now', sidecar: '/somewhere/else.xmp' } });
    expect(needsApplying(applied, path.resolve('/photos/a.xmp'))).toBe(true);
  });
});

describe('parseRecord', () => {
  test('round-trips a full record', () => {
    const full = record({
      marks: { reject: true, stars: 2, label: 'reject', keywords: ['x'] },
      sources: { cull: { tool: 'cull@0.7.0', at: '2026-08-02T00:00:00.000Z', score: 0.4 } },
      applied: { at: '2026-08-02T00:01:00.000Z', sidecar: '/photos/a.xmp' },
    });
    expect(parseRecord(JSON.stringify(full))).toEqual(full);
  });

  test('drops a truncated line instead of throwing', () => {
    expect(parseRecord('{"file":"/a.cr3"')).toBeNull();
    expect(parseRecord('')).toBeNull();
  });

  test('drops a line that is not an object', () => {
    expect(parseRecord('null')).toBeNull();
    expect(parseRecord('42')).toBeNull();
    expect(parseRecord('"a string"')).toBeNull();
  });

  test('requires a non-empty file, the identity key', () => {
    expect(parseRecord('{"size":1}')).toBeNull();
    expect(parseRecord('{"file":""}')).toBeNull();
    expect(parseRecord('{"file":123}')).toBeNull();
  });

  test('fills in the optional fields rather than returning a half record', () => {
    const parsed = parseRecord('{"file":"/a.cr3"}')!;
    expect(parsed).toEqual({ file: '/a.cr3', size: 0, mtimeMs: 0, marks: {}, sources: {} });
    expect('applied' in parsed).toBe(false);
  });

  test('replaces non-object marks and sources with empty ones', () => {
    const parsed = parseRecord('{"file":"/a.cr3","marks":"nope","sources":7}')!;
    expect(parsed.marks).toEqual({});
    expect(parsed.sources).toEqual({});
  });

  test('keeps `applied` only when it is there', () => {
    expect(parseRecord('{"file":"/a.cr3","applied":null}')!.applied).toBeUndefined();
    expect(parseRecord('{"file":"/a.cr3","applied":{"at":"t","sidecar":"/s"}}')!.applied).toEqual({
      at: 't',
      sidecar: '/s',
    });
  });
});
