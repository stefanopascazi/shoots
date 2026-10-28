/**
 * Pure view logic for the library: merging job reports and the photographer's
 * own marks onto photos, filtering, sorting, totals.
 *
 * What shoots finds is a proposal. The photographer has the last word: a flag,
 * stars or a colour label set by hand overrides the proposal for that field,
 * and the uncertain frames (shallow depth of field rescued by the focus peak)
 * wait for a flag before they count as settled.
 */
import type { ColorLabel, CullResultItem, Flag, LibraryPhoto, Marks, RateResultItem } from '../contract.js';
import type { PhotoFlag } from '@shoots/ui';
import { changeFor, sendStatus, type SendStatus, type SentChange } from '../outbox.js';

export type MarksByPath = Readonly<Record<string, Marks>>;

export interface PhotoView extends LibraryPhoto {
  /** The last rating run's stars. */
  aiStars?: number;
  /** Stars as they stand: yours when set, else shoots'. */
  stars?: number;
  focus?: number;
  aesthetic?: number;
  keywords?: string[];
  blur?: Omit<CullResultItem, 'file'>;
  /** What the photographer set by hand. */
  marks?: Marks;
  /** The flag as it stands: yours when set, else reject for a blurry frame, else unflagged. */
  flag: Flag;
  label?: Exclude<ColorLabel, 'none'>;
  /** Where this photo stands with Lightroom. */
  send: SendStatus;
}

export type Filter = 'all' | 'picks' | 'keepers' | 'rejected' | 'review';
export type LabelFilter = ColorLabel | 'any';
export type Sort = 'name' | 'rating';

/** Paths compare case-insensitively on Windows, where the CLI may echo a different case. */
export const pathKey = (p: string, caseInsensitive: boolean): string => (caseInsensitive ? p.toLowerCase() : p);

export function mergeResults(
  photos: readonly LibraryPhoto[],
  cull: readonly CullResultItem[] | undefined,
  rate: readonly RateResultItem[] | undefined,
  caseInsensitive = false,
  marks: MarksByPath = {},
  sent: Readonly<Record<string, SentChange>> = {},
): PhotoView[] {
  const blur = new Map(cull?.map((r) => [pathKey(r.file, caseInsensitive), r]));
  const rated = new Map(rate?.map((r) => [pathKey(r.file, caseInsensitive), r]));
  return photos.map((p) => {
    const k = pathKey(p.path, caseInsensitive);
    const b = blur.get(k);
    const r = rated.get(k);
    const m = marks[p.path];
    const stars = m?.stars ?? r?.stars;
    return {
      ...p,
      ...(b && { blur: { score: b.score, focusPeak: b.focusPeak, verdict: b.verdict, rescued: b.rescued, aperture: b.aperture, focusMap: b.focusMap } }),
      ...(r && { aiStars: r.stars, focus: r.focus, aesthetic: r.aesthetic, keywords: r.keywords }),
      ...(stars !== undefined && { stars }),
      ...(m && { marks: m }),
      ...(m?.label && m.label !== 'none' && { label: m.label }),
      flag: m?.flag ?? (b?.verdict === 'blurry' ? 'reject' : 'unflagged'),
      send: sendStatus(changeFor(p.path, b, r?.stars, m), sent[p.path]),
    };
  });
}

export const isRejected = (p: PhotoView): boolean => p.flag === 'reject';

/** Uncertain and not yet flagged by hand: the frames the review queue holds. */
export const awaitsReview = (p: PhotoView): boolean => p.blur?.rescued === true && !p.marks?.flag;

/** The badge a tile carries. */
export function flagFor(p: PhotoView): PhotoFlag | undefined {
  if (awaitsReview(p)) return 'review';
  if (p.flag === 'reject') return 'rejected';
  return p.flag === 'pick' ? 'pick' : undefined;
}

/** Who set the flag, in words for the viewer. */
export function verdictSource(p: PhotoView): string | undefined {
  if (p.marks?.flag) return 'Set by you';
  if (!p.blur) return undefined;
  if (p.blur.rescued) return 'Uncertain: soft overall, sharp in one area';
  return p.blur.verdict === 'blurry' ? 'Rejected as blurry' : 'Sharp';
}

const MATCH: Record<Filter, (p: PhotoView) => boolean> = {
  all: () => true,
  picks: (p) => p.flag === 'pick',
  keepers: (p) => !isRejected(p),
  rejected: isRejected,
  review: awaitsReview,
};

const matchesLabel = (p: PhotoView, label: LabelFilter): boolean =>
  label === 'any' ? true : label === 'none' ? p.label === undefined : p.label === label;

export function visible(photos: readonly PhotoView[], filter: Filter, sort: Sort, label: LabelFilter = 'any'): PhotoView[] {
  const kept = photos.filter((p) => MATCH[filter](p) && matchesLabel(p, label));
  if (sort === 'name') return kept;
  // Stable: equal ratings keep their name order.
  return kept
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (b.p.stars ?? -1) - (a.p.stars ?? -1) || a.i - b.i)
    .map((x) => x.p);
}

export interface Totals {
  total: number;
  picks: number;
  rejected: number;
  checked: number;
  toReview: number;
  /** Photos with anything set by hand. */
  marked: number;
  /** Lightroom: not sent yet or changed since, waiting for the plug-in, in the catalog, not in the catalog. */
  toSend: number;
  waiting: number;
  inLightroom: number;
  notInCatalog: number;
  rated: number;
  /** Mean stars over rated photos, or undefined when none are rated. */
  meanStars: number | undefined;
}

export function totals(photos: readonly PhotoView[]): Totals {
  const t: Totals = {
    total: photos.length,
    picks: 0,
    rejected: 0,
    checked: 0,
    toReview: 0,
    marked: 0,
    toSend: 0,
    waiting: 0,
    inLightroom: 0,
    notInCatalog: 0,
    rated: 0,
    meanStars: undefined,
  };
  let stars = 0;
  for (const p of photos) {
    if (p.blur) t.checked++;
    if (p.flag === 'pick') t.picks++;
    if (isRejected(p)) t.rejected++;
    if (awaitsReview(p)) t.toReview++;
    if (p.marks) t.marked++;
    if (p.send === 'unsent' || p.send === 'changed') t.toSend++;
    else if (p.send === 'pending') t.waiting++;
    else if (p.send === 'applied') t.inLightroom++;
    else if (p.send === 'missing') t.notInCatalog++;
    // Rated: by a rating run, or by hand with at least one star. Taking the stars off by hand is not a rating.
    if (p.aiStars !== undefined || (p.stars ?? 0) > 0) {
      t.rated++;
      stars += p.stars ?? 0;
    }
  }
  t.meanStars = t.rated ? stars / t.rated : undefined;
  return t;
}

/** One line on where the folder stands with Lightroom, or undefined when nothing has been sent or is to send. */
export function sendSummary(t: Totals): string | undefined {
  const parts: string[] = [];
  if (t.inLightroom) parts.push(`${t.inLightroom} in Lightroom`);
  if (t.waiting) parts.push(`${t.waiting} waiting for Lightroom`);
  if (t.notInCatalog) parts.push(`${t.notInCatalog} not in the catalog`);
  if (t.toSend) parts.push(`${t.toSend} not sent yet`);
  return parts.length ? parts.join(' · ') : undefined;
}

/** The viewer's words for a photo's state with Lightroom. */
export const SEND_LABEL: Record<SendStatus, string | undefined> = {
  none: undefined,
  unsent: 'Not sent yet',
  changed: 'Changed since it was sent',
  pending: 'Waiting for Lightroom',
  applied: 'In Lightroom',
  missing: 'Not in the Lightroom catalog',
};

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
