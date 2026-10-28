/** Pure view logic for the library: merging job reports onto photos, filtering, sorting, totals. */
import type { CullReport, LibraryPhoto, RateReport } from '../contract.js';

export interface PhotoView extends LibraryPhoto {
  stars?: number;
  focus?: number;
  aesthetic?: number;
  keywords?: string[];
  blur?: { score: number; verdict: 'sharp' | 'blurry'; rescued: boolean };
}

export type Filter = 'all' | 'keepers' | 'blurry';
export type Sort = 'name' | 'rating';

/** Paths compare case-insensitively on Windows, where the CLI may echo a different case. */
const keyOf = (p: string, caseInsensitive: boolean): string => (caseInsensitive ? p.toLowerCase() : p);

export function mergeResults(
  photos: readonly LibraryPhoto[],
  cull: CullReport | undefined,
  rate: RateReport | undefined,
  caseInsensitive = false,
): PhotoView[] {
  const blur = new Map(cull?.results.map((r) => [keyOf(r.file, caseInsensitive), r]));
  const rated = new Map(rate?.results.map((r) => [keyOf(r.file, caseInsensitive), r]));
  return photos.map((p) => {
    const k = keyOf(p.path, caseInsensitive);
    const b = blur.get(k);
    const r = rated.get(k);
    return {
      ...p,
      ...(b && { blur: { score: b.score, verdict: b.verdict, rescued: b.rescued } }),
      ...(r && { stars: r.stars, focus: r.focus, aesthetic: r.aesthetic, keywords: r.keywords }),
    };
  });
}

export const isBlurry = (p: PhotoView): boolean => p.blur?.verdict === 'blurry';

export function visible(photos: readonly PhotoView[], filter: Filter, sort: Sort): PhotoView[] {
  const kept = photos.filter((p) => (filter === 'all' ? true : filter === 'blurry' ? isBlurry(p) : !isBlurry(p)));
  if (sort === 'name') return kept;
  // Stable: equal ratings keep their name order.
  return kept
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (b.p.stars ?? -1) - (a.p.stars ?? -1) || a.i - b.i)
    .map((x) => x.p);
}

export interface Totals {
  total: number;
  blurry: number;
  checked: number;
  rated: number;
  /** Mean stars over rated photos, or undefined when none are rated. */
  meanStars: number | undefined;
}

export function totals(photos: readonly PhotoView[]): Totals {
  let blurry = 0;
  let checked = 0;
  let rated = 0;
  let stars = 0;
  for (const p of photos) {
    if (p.blur) checked++;
    if (isBlurry(p)) blurry++;
    if (p.stars !== undefined) {
      rated++;
      stars += p.stars;
    }
  }
  return { total: photos.length, blurry, checked, rated, meanStars: rated ? stars / rated : undefined };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}

/** Last path segment, for headings; handles both separators. */
export const folderName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
