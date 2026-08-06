/**
 * Canonical triage marks → RapidRAW's own annotation fields.
 *
 * RapidRAW keeps all three in the same `.rrdata` as the develop settings:
 * `rating` is a bare 0–5 integer, and both the colour label and free keywords
 * live in one `tags` array, told apart by a namespace prefix — `color:red` for
 * the label, `user:portrait` for a keyword. Nothing else is allowed to look like
 * a label, which is what makes replacing one safe.
 */
import type { LabelSet } from '../../../triage/labelSets.js';
import type { TriageMarks } from '../../../triage/schema.js';
import type { AnnotationTags } from '../types.js';
import type { RrSidecar } from './ingest.js';

const COLOR_PREFIX = 'color:';
const USER_PREFIX = 'user:';

/**
 * RapidRAW lowercases a keyword the moment it is typed, so anything else would
 * come back changed and read as a second, different tag.
 */
const normalizeKeyword = (keyword: string): string => keyword.trim().toLowerCase();

/**
 * Apply marks to a sidecar document, returning the new one plus what changed.
 *
 * The label replaces any existing `color:` tag rather than joining it: RapidRAW
 * treats the label as single-valued (its own menu offers "no label" to clear
 * it), and two of them would make the swatch depend on array order.
 */
export function applyMarks(
  sidecar: RrSidecar,
  marks: TriageMarks,
  labels: LabelSet,
): { sidecar: RrSidecar; written: AnnotationTags } {
  const written: AnnotationTags = {};
  const next: RrSidecar = { ...sidecar };

  if (typeof marks.stars === 'number') {
    next.rating = Math.max(0, Math.min(5, Math.round(marks.stars)));
    written['rating'] = next.rating;
  }

  // Rejection with no label of its own still has to land somewhere filterable:
  // RapidRAW has no reject flag at all, so the colour label carries it — the
  // same fallback the ACR adapter makes for the same reason.
  const label = marks.label ?? (marks.reject ? 'reject' : undefined);
  const keywords = marks.keywords?.map(normalizeKeyword).filter(Boolean) ?? [];

  if (label || keywords.length > 0) {
    const existing = Array.isArray(sidecar.tags) ? sidecar.tags.filter((t) => typeof t === 'string') : [];
    let tags = [...existing];
    if (label) {
      tags = tags.filter((t) => !t.startsWith(COLOR_PREFIX));
      tags.push(`${COLOR_PREFIX}${labels[label]}`);
      written['label'] = labels[label];
    }
    for (const keyword of keywords) {
      const tag = `${USER_PREFIX}${keyword}`;
      if (!tags.includes(tag)) tags.push(tag);
    }
    if (keywords.length > 0) written['tags'] = keywords;
    next.tags = tags;
  }

  return { sidecar: next, written };
}
