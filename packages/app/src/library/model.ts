/**
 * Pure view logic for the library: merging job reports and the photographer's
 * own decisions onto photos, filtering, sorting, totals.
 *
 * The cull verdict is a proposal. A frame can be soft on purpose, so the person
 * has the last word: a decision overrides the verdict in either direction, and
 * the uncertain frames (shallow depth of field rescued by the focus peak) wait
 * for one before they count as settled.
 */
import type { CullResultItem, Decision, LibraryPhoto, RateResultItem } from '../contract.js';
import type { PhotoFlag } from '@shoots/ui';

export type { Decision };
export type Decisions = Readonly<Record<string, Decision>>;

export interface PhotoView extends LibraryPhoto {
  stars?: number;
  focus?: number;
  aesthetic?: number;
  keywords?: string[];
  blur?: Omit<CullResultItem, 'file'>;
  /** The photographer's call, when they made one. */
  decision?: Decision;
}

export type Filter = 'all' | 'keepers' | 'rejected' | 'review';
export type Sort = 'name' | 'rating';

/** Paths compare case-insensitively on Windows, where the CLI may echo a different case. */
export const pathKey = (p: string, caseInsensitive: boolean): string => (caseInsensitive ? p.toLowerCase() : p);

export function mergeResults(
  photos: readonly LibraryPhoto[],
  cull: readonly CullResultItem[] | undefined,
  rate: readonly RateResultItem[] | undefined,
  caseInsensitive = false,
  decisions: Decisions = {},
): PhotoView[] {
  const blur = new Map(cull?.map((r) => [pathKey(r.file, caseInsensitive), r]));
  const rated = new Map(rate?.map((r) => [pathKey(r.file, caseInsensitive), r]));
  return photos.map((p) => {
    const k = pathKey(p.path, caseInsensitive);
    const b = blur.get(k);
    const r = rated.get(k);
    const decision = decisions[p.path];
    return {
      ...p,
      ...(b && { blur: { score: b.score, focusPeak: b.focusPeak, verdict: b.verdict, rescued: b.rescued, aperture: b.aperture, focusMap: b.focusMap } }),
      ...(r && { stars: r.stars, focus: r.focus, aesthetic: r.aesthetic, keywords: r.keywords }),
      ...(decision && { decision }),
    };
  });
}

/** Rejected, by the person's decision when there is one, else by the verdict. */
export const isRejected = (p: PhotoView): boolean => (p.decision ? p.decision === 'reject' : p.blur?.verdict === 'blurry');

/** Uncertain and not yet decided: the frames the review queue holds. */
export const awaitsReview = (p: PhotoView): boolean => p.blur?.rescued === true && !p.decision;

/** The badge a tile carries. */
export function flagFor(p: PhotoView): PhotoFlag | undefined {
  if (awaitsReview(p)) return 'review';
  return isRejected(p) ? 'rejected' : undefined;
}

/** Who settled this frame, in words for the viewer. */
export function verdictSource(p: PhotoView): string | undefined {
  if (p.decision) return p.decision === 'keep' ? 'Kept by you' : 'Rejected by you';
  if (!p.blur) return undefined;
  if (p.blur.rescued) return 'Uncertain: soft overall, sharp in one area';
  return p.blur.verdict === 'blurry' ? 'Rejected as blurry' : 'Sharp';
}

const MATCH: Record<Filter, (p: PhotoView) => boolean> = {
  all: () => true,
  keepers: (p) => !isRejected(p),
  rejected: isRejected,
  review: awaitsReview,
};

export function visible(photos: readonly PhotoView[], filter: Filter, sort: Sort): PhotoView[] {
  const kept = photos.filter(MATCH[filter]);
  if (sort === 'name') return kept;
  // Stable: equal ratings keep their name order.
  return kept
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (b.p.stars ?? -1) - (a.p.stars ?? -1) || a.i - b.i)
    .map((x) => x.p);
}

export interface Totals {
  total: number;
  rejected: number;
  checked: number;
  toReview: number;
  /** Frames where the person overrode or confirmed the verdict. */
  decided: number;
  rated: number;
  /** Mean stars over rated photos, or undefined when none are rated. */
  meanStars: number | undefined;
}

export function totals(photos: readonly PhotoView[]): Totals {
  const t: Totals = { total: photos.length, rejected: 0, checked: 0, toReview: 0, decided: 0, rated: 0, meanStars: undefined };
  let stars = 0;
  for (const p of photos) {
    if (p.blur) t.checked++;
    if (isRejected(p)) t.rejected++;
    if (awaitsReview(p)) t.toReview++;
    if (p.decision) t.decided++;
    if (p.stars !== undefined) {
      t.rated++;
      stars += p.stars;
    }
  }
  t.meanStars = t.rated ? stars / t.rated : undefined;
  return t;
}

/**
 * Focus map → intensities in [0, 1], row-major, against the frame's own
 * sharpest tile. The square root keeps mid-sharpness regions visible instead of
 * letting one very sharp tile crush the rest.
 */
export function heatLevels(tiles: readonly number[]): number[] {
  const max = tiles.reduce((m, v) => (v > m ? v : m), 0);
  return tiles.map((v) => (max > 0 ? Math.sqrt(Math.max(0, v) / max) : 0));
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
