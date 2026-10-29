import { describe, expect, test } from 'bun:test';
import { exifRows } from '../src/library/exifRows.js';
import type { CullResultItem, LibraryPhoto, RateResultItem } from '../src/contract.js';
import { heatColor } from '../src/library/FocusHeatmap.js';
import { parseLegacyDecisions, withMarks } from '../src/library/marks.js';
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
import { toggleLabel, viewerKey } from '../src/library/viewerKeys.js';
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

const cull: CullResultItem[] = [
  item('C:\\shoot\\a.cr3', 'sharp'),
  item('c:\\SHOOT\\b.cr3', 'blurry'),
  item('C:\\shoot\\d.cr3', 'sharp', true),
];

const rate: RateResultItem[] = [
  { file: 'C:\\shoot\\a.cr3', stars: 2, focus: 0.9, aesthetic: 0.5, keywords: [] },
  { file: 'C:\\shoot\\c.cr3', stars: 4, focus: 0.9, aesthetic: 0.7, keywords: ['portrait'] },
];

describe('mergeResults', () => {
  test('attaches blur, focus data and stars by path', () => {
    const [a, b, c] = mergeResults(PHOTOS, cull, rate);
    expect(a.blur).toMatchObject({ verdict: 'sharp', focusPeak: 100, aperture: 1.4 });
    expect(a.blur?.focusMap?.tiles).toEqual([10, 40]);
    expect(a.stars).toBe(2);
    expect(a.aiStars).toBe(2);
    expect(b.blur).toBeUndefined(); // case differs and matching is exact
    expect(c.stars).toBe(4);
  });

  test('matches case-insensitively on Windows', () => {
    expect(mergeResults(PHOTOS, cull, undefined, true)[1].blur?.verdict).toBe('blurry');
  });

  test('without anything known every photo is unflagged with nothing to send', () => {
    expect(mergeResults(PHOTOS, undefined, undefined)).toEqual(PHOTOS.map((p) => ({ ...p, flag: 'unflagged', send: 'none' })));
  });

  test('your marks override shoots field by field', () => {
    const [a, b] = mergeResults(PHOTOS, cull, rate, true, {
      'C:\\shoot\\a.cr3': { stars: 5, label: 'red' },
      'C:\\shoot\\b.cr3': { flag: 'pick' },
    });
    expect(a).toMatchObject({ stars: 5, aiStars: 2, label: 'red', flag: 'unflagged' });
    expect(b.flag).toBe('pick');
  });

  test('a label of none shows no label', () => {
    expect(mergeResults(PHOTOS, undefined, undefined, false, { 'C:\\shoot\\a.cr3': { label: 'none' } })[0].label).toBeUndefined();
  });
});

describe('flags', () => {
  const merged = mergeResults(PHOTOS, cull, rate, true);
  const [sharp, blurry, unchecked, uncertain] = merged;

  test('the verdict sets the flag until you do', () => {
    expect(isRejected(blurry)).toBe(true);
    expect(sharp.flag).toBe('unflagged');
    expect(unchecked.flag).toBe('unflagged');
  });

  test('only uncertain frames without a flag of yours await review', () => {
    expect(awaitsReview(uncertain)).toBe(true);
    expect(awaitsReview({ ...uncertain, marks: { flag: 'pick' } })).toBe(false);
    expect(awaitsReview({ ...uncertain, marks: { stars: 3 } })).toBe(true);
    expect(awaitsReview(blurry)).toBe(false);
  });

  test('badges and words', () => {
    expect(flagFor(uncertain)).toBe('review');
    expect(flagFor(blurry)).toBe('rejected');
    expect(flagFor({ ...sharp, flag: 'pick' })).toBe('pick');
    expect(flagFor(sharp)).toBeUndefined();
    expect(verdictSource(blurry)).toBe('Rejected as blurry');
    expect(verdictSource({ ...blurry, marks: { flag: 'pick' } })).toBe('Set by you');
    expect(verdictSource(unchecked)).toBeUndefined();
  });
});

describe('visible', () => {
  const merged = mergeResults(PHOTOS, cull, rate, true, {
    'C:\\shoot\\a.cr3': { flag: 'reject' },
    'C:\\shoot\\c.cr3': { flag: 'pick', label: 'green' },
  });

  test('filters by the flag as it stands', () => {
    expect(visible(merged, 'rejected', 'name').map((p) => p.name)).toEqual(['a.cr3', 'b.cr3']);
    expect(visible(merged, 'picks', 'name').map((p) => p.name)).toEqual(['c.cr3']);
    expect(visible(merged, 'keepers', 'name').map((p) => p.name)).toEqual(['c.cr3', 'd.cr3']);
    expect(visible(merged, 'review', 'name').map((p) => p.name)).toEqual(['d.cr3']);
  });

  test('filters by colour label, and by its absence', () => {
    expect(visible(merged, 'all', 'name', 'green').map((p) => p.name)).toEqual(['c.cr3']);
    expect(visible(merged, 'all', 'name', 'none').map((p) => p.name)).toEqual(['a.cr3', 'b.cr3', 'd.cr3']);
  });

  test('rating sort puts unrated last and keeps name order on ties', () => {
    expect(visible(merged, 'all', 'rating').map((p) => p.name)).toEqual(['c.cr3', 'a.cr3', 'b.cr3', 'd.cr3']);
  });
});

describe('totals', () => {
  test('counts picks, rejects, review queue, marks and the mean', () => {
    const merged = mergeResults(PHOTOS, cull, rate, true, { 'C:\\shoot\\b.cr3': { flag: 'pick' } });
    expect(totals(merged)).toMatchObject({ total: 4, picks: 1, rejected: 0, checked: 3, toReview: 1, marked: 1, rated: 2, meanStars: 3 });
    expect(totals([]).meanStars).toBeUndefined();
  });
});

describe('marks on the client', () => {
  test('withMarks sets, clears, and drops a photo left with nothing', () => {
    const a = withMarks({}, 'x', { flag: 'pick' });
    expect(a).toEqual({ x: { flag: 'pick' } });
    expect(withMarks(a, 'x', { stars: 3 })).toEqual({ x: { flag: 'pick', stars: 3 } });
    expect(withMarks(a, 'x', { flag: null })).toEqual({});
    expect(a).toEqual({ x: { flag: 'pick' } }); // never mutated
  });

  test('old browser decisions become flags: keeping a frame was picking it', () => {
    expect(parseLegacyDecisions('{"a":"keep","b":"reject","c":"maybe"}')).toEqual({ a: { flag: 'pick' }, b: { flag: 'reject' } });
    expect(parseLegacyDecisions('[1]')).toEqual({});
    expect(parseLegacyDecisions('nope')).toEqual({});
    expect(parseLegacyDecisions(null)).toEqual({});
  });
});

describe('viewer keys, as in Lightroom', () => {
  test('flags', () => {
    expect(viewerKey('p')).toEqual({ type: 'mark', patch: { flag: 'pick' } });
    expect(viewerKey('K')).toEqual({ type: 'mark', patch: { flag: 'pick' } });
    expect(viewerKey('x')).toEqual({ type: 'mark', patch: { flag: 'reject' } });
    expect(viewerKey('u')).toEqual({ type: 'mark', patch: { flag: 'unflagged' } });
  });

  test('stars 1–5, 0 for none, labels 6–9 as in Lightroom', () => {
    expect(viewerKey('0')).toEqual({ type: 'mark', patch: { stars: 0 } });
    expect(viewerKey('5')).toEqual({ type: 'mark', patch: { stars: 5 } });
    expect(viewerKey('6')).toEqual({ type: 'mark', patch: { label: 'red' } });
    expect(viewerKey('9')).toEqual({ type: 'mark', patch: { label: 'blue' } });
  });

  test('navigation, and keys it does not know', () => {
    expect(viewerKey('ArrowRight')).toEqual({ type: 'next' });
    expect(viewerKey('Escape')).toEqual({ type: 'close' });
    expect(viewerKey('s')).toEqual({ type: 'skip' });
    expect(viewerKey('q')).toBeNull();
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

describe('routes', () => {
  test('parseRoute falls back to the first route', () => {
    const routes = ['library', 'setup'] as const;
    expect(parseRoute('#setup', routes)).toBe('setup');
    expect(parseRoute('#nope', routes)).toBe('library');
    expect(parseRoute('', routes)).toBe('library');
  });
});

describe('label toggle', () => {
  test('the same label again clears it', () => {
    expect(toggleLabel({ label: 'red' }, 'red')).toEqual({ label: 'none' });
  });

  test('another label replaces it; other marks pass through', () => {
    expect(toggleLabel({ label: 'green' }, 'red')).toEqual({ label: 'green' });
    expect(toggleLabel({ label: 'purple' }, undefined)).toEqual({ label: 'purple' });
    expect(toggleLabel({ stars: 3 }, 'red')).toEqual({ stars: 3 });
  });
});

describe('rated', () => {
  test('stars taken off by hand do not count as a rating; a rating run of 0 does', () => {
    const manual = mergeResults(PHOTOS.slice(0, 1), undefined, undefined, false, { [PHOTOS[0].path]: { stars: 0 } });
    expect(totals(manual).rated).toBe(0);
    const run = mergeResults(PHOTOS.slice(0, 1), undefined, [{ file: PHOTOS[0].path, stars: 0, focus: 0, aesthetic: 0, keywords: [] }]);
    expect(totals(run).rated).toBe(1);
  });
});

describe('exifRows', () => {
  test('recorded fields only, in display order', () => {
    expect(exifRows({ lens: '85mm', taken: '2026-05-01', location: '1, 2' })).toEqual([
      { label: 'Taken', value: '2026-05-01' },
      { label: 'Lens', value: '85mm' },
      { label: 'Location', value: '1, 2' },
    ]);
    expect(exifRows({})).toEqual([]);
  });
});
