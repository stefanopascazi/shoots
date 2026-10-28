/**
 * The viewer's keyboard, on Lightroom's keys so hands already know it:
 * P pick, X reject, U unflag, 1–5 stars, 0 no stars, 6–9 red/yellow/green/blue
 * (a label key again on the same label clears it). Purple has no key, as in Lightroom.
 * K and D are kept for those used to the shell's review.
 */
import type { MarksPatch } from '../contract.js';

export type ViewerAction =
  | { type: 'mark'; patch: MarksPatch }
  | { type: 'prev' }
  | { type: 'next' }
  | { type: 'skip' }
  | { type: 'heatmap' }
  | { type: 'close' };

const LABEL_KEYS = { '6': 'red', '7': 'yellow', '8': 'green', '9': 'blue' } as const;

export function viewerKey(key: string): ViewerAction | null {
  const k = key.toLowerCase();
  if (k === 'escape') return { type: 'close' };
  if (k === 'arrowleft') return { type: 'prev' };
  if (k === 'arrowright') return { type: 'next' };
  if (k === 's') return { type: 'skip' };
  if (k === 'h') return { type: 'heatmap' };
  if (k === 'p' || k === 'k') return { type: 'mark', patch: { flag: 'pick' } };
  if (k === 'x' || k === 'd') return { type: 'mark', patch: { flag: 'reject' } };
  if (k === 'u') return { type: 'mark', patch: { flag: 'unflagged' } };
  if (/^[0-5]$/.test(k)) return { type: 'mark', patch: { stars: Number(k) } };
  if (k in LABEL_KEYS) return { type: 'mark', patch: { label: LABEL_KEYS[k as keyof typeof LABEL_KEYS] } };
  return null;
}

/** A label key on the label already set clears it, as in Lightroom; anything else passes through. */
export function toggleLabel(patch: MarksPatch, current: string | undefined): MarksPatch {
  return patch.label && patch.label !== 'none' && patch.label === current ? { label: 'none' } : patch;
}
