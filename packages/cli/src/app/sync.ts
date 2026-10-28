/**
 * Following Lightroom: what to do with the ratings, flags and labels the
 * plug-in reads back from the catalog. Last change wins.
 *
 * - A field Lightroom changed since its last report is the photographer's
 *   newest word on it, and becomes the app's mark.
 * - The first report of a photo imports what is set there (stars, a flag, a
 *   label) where the app has no mark of its own for that field. Lightroom's
 *   defaults — no stars, unflagged, no label — are not a decision and import
 *   nothing, so they never hide what shoots proposed.
 * - A value that only echoes what the app sent is not a change at all.
 *
 * Pure: the store applies what this returns.
 */
import type { ColorLabel, Flag, LightroomChange, LightroomState, Marks, MarksPatch, PickStatus } from '@shoots/app';

const FLAG_OF: Record<PickStatus, Flag> = { 1: 'pick', [-1]: 'reject', 0: 'unflagged' };

type Field = 'rating' | 'pick' | 'label';

const DEFAULTS: Record<Field, number | string> = { rating: 0, pick: 0, label: 'none' };
const MARK_OF: Record<Field, keyof Marks> = { rating: 'stars', pick: 'flag', label: 'label' };

function asMark(field: Field, value: LightroomState[Field]): Marks[keyof Marks] {
  if (field === 'pick') return FLAG_OF[value as PickStatus];
  return value as number | ColorLabel;
}

/** The marks patch a Lightroom report calls for; empty when nothing should change in the app. */
export function reconcile(
  previous: LightroomState | undefined,
  now: LightroomState,
  marks: Marks | undefined,
  sent: LightroomChange | undefined,
): MarksPatch {
  const patch: MarksPatch = {};
  for (const field of ['rating', 'pick', 'label'] as const) {
    const value = now[field];
    if (previous && previous[field] === value) continue;
    // What the app sent, landing: not a change by the photographer.
    if (sent && sent[field] !== null && sent[field] === value) continue;
    if (!previous && (value === DEFAULTS[field] || marks?.[MARK_OF[field]] !== undefined)) continue;
    (patch as Record<string, unknown>)[MARK_OF[field]] = asMark(field, value);
  }
  return patch;
}

/** Whether Lightroom already holds every field a change would set. */
export function satisfies(state: LightroomState, change: LightroomChange): boolean {
  return (
    (change.rating === null || change.rating === state.rating) &&
    (change.pick === null || change.pick === state.pick) &&
    (change.label === null || change.label === state.label)
  );
}
