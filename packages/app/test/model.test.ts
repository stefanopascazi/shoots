import { describe, expect, test } from 'bun:test';
import type { CullReport, LibraryPhoto, RateReport } from '../src/contract.js';
import { parseDecisions, withDecision } from '../src/library/decisions.js';
import { heatColor } from '../src/library/FocusHeatmap.js';
import {
  awaitsReview,
  flagFor,
  folderName,
  formatBytes,
  heatLevels,
  isRejected,
  mergeResults,
  totals,
  verdictSource,
  visible,
} from '../src/library/model.js';
import { pushRecent } from '../src/library/recentFolders.js';
import { parseRoute } from '../src/hooks/useHashRoute.js';

const photo = (name: string): LibraryPhoto => ({ path: `C:\\shoot\\${name}`, name, kind: 'raw', size: 1, mtime: 0 });
const PHOTOS = [photo('a.cr3'), photo('b.cr3'), photo('c.cr3'), photo('d.cr3')];

const item = (file: string, verdict: 'sharp' | 'blurry', rescued = false) => ({
  file,
  score: verdict === 'sharp' ? 900 : 20,
  focusPeak: rescued ? 600 : 100,
  verdict,
  rescued,
  aperture: 1.4,
  focusMap: { cols: 2, rows: 1, tiles: [10, 40] },
});

const cull: CullReport = {
  command: 'cull',
  results: [
    item('C:\\shoot\\a.cr3', 'sharp'),
    item('c:\\SHOOT\\b.cr3', 'blurry'),
    item('C:\\shoot\\d.cr3', 'sharp', true),
  ],
  summary: { total: 3, sharp: 2, blurry: 1, rescued: 1, failed: 0 },
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
  test('attaches blur, focus data and stars by path', () => {
    const [a, b, c] = mergeResults(PHOTOS, cull, rate);
    expect(a.blur).toMatchObject({ verdict: 'sharp', focusPeak: 100, aperture: 1.4 });
    expect(a.blur?.focusMap?.tiles).toEqual([10, 40]);
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

  test('carries the decisions made for each path', () => {
    const merged = mergeResults(PHOTOS, cull, undefined, true, { 'C:\\shoot\\b.cr3': 'keep' });
    expect(merged[1].decision).toBe('keep');
    expect(merged[0].decision).toBeUndefined();
  });
});

describe('verdicts are proposals', () => {
  const merged = mergeResults(PHOTOS, cull, rate, true);
  const [sharp, blurry, unchecked, uncertain] = merged;

  test('the verdict decides until the person does', () => {
    expect(isRejected(blurry)).toBe(true);
    expect(isRejected(sharp)).toBe(false);
    expect(isRejected(unchecked)).toBe(false);
  });

  test('a decision overrides the verdict both ways', () => {
    expect(isRejected({ ...blurry, decision: 'keep' })).toBe(false);
    expect(isRejected({ ...sharp, decision: 'reject' })).toBe(true);
  });

  test('only undecided rescued frames await review', () => {
    expect(awaitsReview(uncertain)).toBe(true);
    expect(awaitsReview({ ...uncertain, decision: 'keep' })).toBe(false);
    expect(awaitsReview(blurry)).toBe(false);
  });

  test('flags and the words for each state', () => {
    expect(flagFor(uncertain)).toBe('review');
    expect(flagFor(blurry)).toBe('rejected');
    expect(flagFor(sharp)).toBeUndefined();
    expect(flagFor({ ...blurry, decision: 'keep' })).toBeUndefined();
    expect(verdictSource(blurry)).toBe('Rejected as blurry');
    expect(verdictSource({ ...blurry, decision: 'keep' })).toBe('Kept by you');
    expect(verdictSource(unchecked)).toBeUndefined();
  });
});

describe('visible', () => {
  const merged = mergeResults(PHOTOS, cull, rate, true, { 'C:\\shoot\\a.cr3': 'reject' });

  test('filters by the effective verdict', () => {
    expect(visible(merged, 'rejected', 'name').map((p) => p.name)).toEqual(['a.cr3', 'b.cr3']);
    expect(visible(merged, 'keepers', 'name').map((p) => p.name)).toEqual(['c.cr3', 'd.cr3']);
    expect(visible(merged, 'review', 'name').map((p) => p.name)).toEqual(['d.cr3']);
  });

  test('rating sort puts unrated last and keeps name order on ties', () => {
    expect(visible(merged, 'all', 'rating').map((p) => p.name)).toEqual(['c.cr3', 'a.cr3', 'b.cr3', 'd.cr3']);
  });
});

describe('totals', () => {
  test('counts rejected, review queue, decisions and the mean', () => {
    const merged = mergeResults(PHOTOS, cull, rate, true, { 'C:\\shoot\\b.cr3': 'keep' });
    expect(totals(merged)).toEqual({ total: 4, rejected: 0, checked: 3, toReview: 1, decided: 1, rated: 2, meanStars: 3 });
    expect(totals([]).meanStars).toBeUndefined();
  });
});

describe('decisions', () => {
  test('set, replace and clear', () => {
    const a = withDecision({}, 'x', 'keep');
    expect(a).toEqual({ x: 'keep' });
    expect(withDecision(a, 'x', 'reject')).toEqual({ x: 'reject' });
    expect(withDecision(a, 'x', undefined)).toEqual({});
    expect(a).toEqual({ x: 'keep' }); // never mutated
  });

  test('parsing drops anything that is not a decision', () => {
    expect(parseDecisions('{"a":"keep","b":"reject","c":"maybe","d":1}')).toEqual({ a: 'keep', b: 'reject' });
    expect(parseDecisions('[1]')).toEqual({});
    expect(parseDecisions('nope')).toEqual({});
    expect(parseDecisions(null)).toEqual({});
  });
});

describe('focus heatmap', () => {
  test('levels are relative to the sharpest tile, square-rooted', () => {
    expect(heatLevels([0, 25, 100])).toEqual([0, 0.5, 1]);
    expect(heatLevels([0, 0])).toEqual([0, 0]);
  });

  test('the softest band stays clear, the sharpest is hottest', () => {
    expect(heatColor(0)).toBe('transparent');
    expect(heatColor(1)).toBe('#fde047');
    expect(heatColor(2)).toBe('#fde047');
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
