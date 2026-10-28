/**
 * What "Send to Lightroom" sends, decided in one place for the server (which
 * queues it) and the page (which shows what has gone and what has changed).
 *
 * A photo carries up to three fields into the catalog. A null field is left
 * alone, so nothing the photographer set in Lightroom is overwritten without a
 * reason:
 *   - `pick`: your flag when you set one (pick 1, reject -1, unflagged 0);
 *     otherwise -1 when the cull found it blurry, else nothing.
 *   - `rating`: your stars when you set them, else the last rating run's.
 *   - `label`: your colour label, when you set one (`none` clears it).
 */
import type { ColorLabel, CullResultItem, Flag, Marks, MarksPatch, ResetPart } from './contract.js';

export type PickStatus = -1 | 0 | 1;

/** Every value Lightroom accepts as a colour label, `none` included. */
export const COLOR_LABELS: readonly ColorLabel[] = ['red', 'yellow', 'green', 'blue', 'purple', 'none'];
export const FLAGS: readonly Flag[] = ['pick', 'reject', 'unflagged'];

export const PICK_OF: Record<Flag, PickStatus> = { pick: 1, reject: -1, unflagged: 0 };

export const RESET_PARTS: readonly ResetPart[] = ['cull', 'rate', 'marks', 'sent'];

export interface LightroomChange {
  path: string;
  rating: number | null;
  pick: PickStatus | null;
  label: ColorLabel | null;
}

export type SendState = 'pending' | 'applied' | 'missing';

/** A queued change and what became of it. */
export interface SentChange extends LightroomChange {
  state: SendState;
}

export function changeFor(
  path: string,
  cull: Pick<CullResultItem, 'verdict'> | undefined,
  aiStars: number | undefined,
  marks: Marks | undefined,
): LightroomChange | null {
  const pick: PickStatus | null = marks?.flag ? PICK_OF[marks.flag] : cull?.verdict === 'blurry' ? -1 : null;
  const rating = marks?.stars ?? aiStars ?? null;
  const label = marks?.label ?? null;
  return pick === null && rating === null && label === null ? null : { path, rating, pick, label };
}

export const sameChange = (a: LightroomChange, b: LightroomChange): boolean =>
  a.rating === b.rating && a.pick === b.pick && a.label === b.label;

/**
 * Where a photo stands with Lightroom: nothing to send, not sent yet, on its
 * way, in the catalog, not in the catalog, or changed since it was sent.
 */
export type SendStatus = 'none' | 'unsent' | SendState | 'changed';

export function sendStatus(current: LightroomChange | null, sent: SentChange | undefined): SendStatus {
  if (!sent) return current ? 'unsent' : 'none';
  if (!current) return sent.state === 'pending' ? 'pending' : 'none';
  return sameChange(current, sent) ? sent.state : 'changed';
}

/** Keeps only valid marks fields; null means "clear this field". */
export function sanitizeMarksPatch(raw: unknown): MarksPatch {
  if (!raw || typeof raw !== 'object') return {};
  const p = raw as Record<string, unknown>;
  const out: MarksPatch = {};
  if (p.flag === null || FLAGS.includes(p.flag as Flag)) out.flag = p.flag as Flag | null;
  if (p.stars === null || (Number.isInteger(p.stars) && (p.stars as number) >= 0 && (p.stars as number) <= 5)) out.stars = p.stars as number | null;
  if (p.label === null || COLOR_LABELS.includes(p.label as ColorLabel)) out.label = p.label as ColorLabel | null;
  return out;
}

/** Marks with a patch applied; undefined when nothing is left set. */
export function applyMarksPatch(marks: Marks | undefined, patch: MarksPatch): Marks | undefined {
  const next: Marks = { ...marks };
  for (const key of ['flag', 'stars', 'label'] as const) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === null || value === undefined) delete next[key];
    else (next as Record<string, unknown>)[key] = value;
  }
  return Object.keys(next).length ? next : undefined;
}
