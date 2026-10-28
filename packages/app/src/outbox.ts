/**
 * What "Send to Lightroom" sends, decided in one place for the server (which
 * queues it) and the page (which shows what has gone and what has changed).
 *
 * A photo carries at most two fields into the catalog:
 *   - `pick`: -1 rejected, 0 flag cleared. A rejection — the cull's or yours —
 *     sends -1; your Keep sends 0, which also lifts a reject sent earlier. A
 *     verdict of sharp with no decision sends nothing, so a pick the photographer
 *     set in Lightroom is never overwritten.
 *   - `rating`: the stars from the last rating run.
 */
import type { CullResultItem, Decision } from './contract.js';

export type PickStatus = -1 | 0 | 1;

export interface LightroomChange {
  path: string;
  rating: number | null;
  pick: PickStatus | null;
}

export type SendState = 'pending' | 'applied' | 'missing';

/** A queued change and what became of it. */
export interface SentChange extends LightroomChange {
  state: SendState;
}

export function changeFor(
  path: string,
  cull: Pick<CullResultItem, 'verdict'> | undefined,
  stars: number | undefined,
  decision: Decision | undefined,
): LightroomChange | null {
  const rejected = decision ? decision === 'reject' : cull?.verdict === 'blurry';
  const pick: PickStatus | null = rejected ? -1 : decision === 'keep' ? 0 : null;
  const rating = stars ?? null;
  return pick === null && rating === null ? null : { path, rating, pick };
}

export const sameChange = (a: LightroomChange, b: LightroomChange): boolean => a.rating === b.rating && a.pick === b.pick;

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
