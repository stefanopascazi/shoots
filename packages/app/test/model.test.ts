import { describe, expect, test } from 'bun:test';
import type { CullReport, LibraryPhoto, RateReport } from '../src/contract.js';
import { folderName, formatBytes, mergeResults, totals, visible } from '../src/library/model.js';
import { pushRecent } from '../src/library/recentFolders.js';
import { parseRoute } from '../src/hooks/useHashRoute.js';

const photo = (name: string): LibraryPhoto => ({ path: `C:\\shoot\\${name}`, name, kind: 'raw', size: 1, mtime: 0 });
const PHOTOS = [photo('a.cr3'), photo('b.cr3'), photo('c.cr3')];

const cull: CullReport = {
  command: 'cull',
  results: [
    { file: 'C:\\shoot\\a.cr3', score: 900, verdict: 'sharp', rescued: false },
    { file: 'c:\\SHOOT\\b.cr3', score: 20, verdict: 'blurry', rescued: false },
  ],
  summary: { total: 2, sharp: 1, blurry: 1, rescued: 0, failed: 0 },
};

const rate: RateReport = {
  command: 'rate',
  profile: 'street',
  results: [
    { file: 'C:\\shoot\\a.cr3', stars: 2, focus: 0.9, aesthetic: 0.5, keywords: [] },
    { file: 'C:\\shoot\\c.cr3', stars: 4, focus: 0.9, aesthetic: 0.7, keywords: ['portrait'] },
  ],
  summary: { total: 2, rated: 2, failed: 0 },
};

describe('mergeResults', () => {
  test('attaches blur and stars by path', () => {
    const [a, b, c] = mergeResults(PHOTOS, cull, rate);
    expect(a.blur?.verdict).toBe('sharp');
    expect(a.stars).toBe(2);
    expect(b.blur).toBeUndefined(); // case differs and matching is exact
    expect(c.stars).toBe(4);
  });

  test('matches case-insensitively on Windows', () => {
    expect(mergeResults(PHOTOS, cull, undefined, true)[1].blur?.verdict).toBe('blurry');
  });

  test('without reports the photos come back unchanged', () => {
    expect(mergeResults(PHOTOS, undefined, undefined)).toEqual(PHOTOS);
  });
});

describe('visible', () => {
  const merged = mergeResults(PHOTOS, cull, rate, true);

  test('filters keepers and blurry', () => {
    expect(visible(merged, 'blurry', 'name').map((p) => p.name)).toEqual(['b.cr3']);
    expect(visible(merged, 'keepers', 'name').map((p) => p.name)).toEqual(['a.cr3', 'c.cr3']);
  });

  test('rating sort puts unrated last and keeps name order on ties', () => {
    expect(visible(merged, 'all', 'rating').map((p) => p.name)).toEqual(['c.cr3', 'a.cr3', 'b.cr3']);
  });
});

describe('totals', () => {
  test('counts checked, blurry, rated and the mean', () => {
    expect(totals(mergeResults(PHOTOS, cull, rate, true))).toEqual({ total: 3, blurry: 1, checked: 2, rated: 2, meanStars: 3 });
    expect(totals([]).meanStars).toBeUndefined();
  });
});

describe('formatting', () => {
  test('bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(33514002)).toBe('32 MB');
  });

  test('folder name on both separators', () => {
    expect(folderName('C:\\Photos\\2025-09-26\\')).toBe('2025-09-26');
    expect(folderName('/home/me/shoot')).toBe('shoot');
  });
});

describe('recent folders and routes', () => {
  test('pushRecent moves to front, dedupes and caps', () => {
    expect(pushRecent(['a', 'b', 'c'], 'b', 3)).toEqual(['b', 'a', 'c']);
    expect(pushRecent(['a', 'b', 'c'], 'd', 3)).toEqual(['d', 'a', 'b']);
  });

  test('parseRoute falls back to the first route', () => {
    const routes = ['library', 'setup'] as const;
    expect(parseRoute('#setup', routes)).toBe('setup');
    expect(parseRoute('#nope', routes)).toBe('library');
    expect(parseRoute('', routes)).toBe('library');
  });
});
