/**
 * The pure half of the exiftool wrapper.
 *
 * Everything that spawns a binary is left to the CLI's end-to-end suite; what is
 * unit-testable here is how a record and a date string are read, which is what
 * every filename template ultimately depends on.
 */
import { describe, expect, test } from 'bun:test';
import { getTagString, parseExifDate, type ExifRecord } from '../src/exif.js';

const record = (tags: Record<string, unknown>): ExifRecord => ({ SourceFile: '/a.cr3', ...tags });

describe('getTagString', () => {
  test('returns a non-empty string tag', () => {
    expect(getTagString(record({ Model: 'Canon EOS R5' }), 'Model')).toBe('Canon EOS R5');
  });

  test('stringifies a numeric tag, so a numeric lens id is still usable', () => {
    expect(getTagString(record({ LensID: 61182 }), 'LensID')).toBe('61182');
    expect(getTagString(record({ ISO: 0 }), 'ISO')).toBe('0');
  });

  test('treats an empty string as absent', () => {
    expect(getTagString(record({ Model: '' }), 'Model')).toBeNull();
  });

  test('is null for a missing tag or a non-scalar value', () => {
    expect(getTagString(record({}), 'Model')).toBeNull();
    expect(getTagString(record({ Keywords: ['a', 'b'] }), 'Keywords')).toBeNull();
    expect(getTagString(record({ Model: null }), 'Model')).toBeNull();
  });
});

describe('parseExifDate', () => {
  test('parses the canonical EXIF spelling', () => {
    const d = parseExifDate('2026:08:02 09:05:03')!;
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 8, 2]);
    expect([d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([9, 5, 3]);
  });

  test('accepts the ISO-ish variants exiftool also emits', () => {
    expect(parseExifDate('2026-08-02 09:05:03')!.getMonth()).toBe(7);
    expect(parseExifDate('2026-08-02T09:05:03')!.getHours()).toBe(9);
  });

  test('ignores subseconds and any timezone suffix', () => {
    // Deliberate: for naming a file, the camera's local wall clock is the answer.
    const withZone = parseExifDate('2026:08:02 09:05:03.25+02:00')!;
    expect(withZone.getHours()).toBe(9);
    expect(withZone.getSeconds()).toBe(3);
  });

  test('builds a local date, not a UTC one', () => {
    const d = parseExifDate('2026:08:02 09:05:03')!;
    expect(d.getTimezoneOffset()).toBe(new Date(2026, 7, 2).getTimezoneOffset());
    expect(d.getHours()).toBe(9);
  });

  test('is null for anything that is not a date', () => {
    expect(parseExifDate(null)).toBeNull();
    expect(parseExifDate(undefined)).toBeNull();
    expect(parseExifDate('')).toBeNull();
    expect(parseExifDate('0000:00:00 00:00:00')).not.toBeNull(); // rolls over, but is a date
    expect(parseExifDate('not a date')).toBeNull();
    expect(parseExifDate('2026:08:02')).toBeNull(); // no time part
  });

  test('anchors on the start of the string', () => {
    expect(parseExifDate('shot at 2026:08:02 09:05:03')).toBeNull();
  });
});
