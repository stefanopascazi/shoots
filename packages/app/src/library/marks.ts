/**
 * The photographer's marks on the client side: the pure update, and the
 * one-time hand-over of decisions an earlier version kept in this browser.
 * The server's database is where marks live.
 */
import type { MarksPatch } from '../contract.js';
import { applyMarksPatch } from '../outbox.js';
import type { MarksByPath } from './model.js';

const LEGACY_PREFIX = 'shoots-decisions:';

/** A new record with `patch` applied to `path`; a photo left with nothing set drops out. */
export function withMarks(record: MarksByPath, path: string, patch: MarksPatch): MarksByPath {
  const next = { ...record };
  const marks = applyMarksPatch(record[path], patch);
  if (marks) next[path] = marks;
  else delete next[path];
  return next;
}

/** Keep/reject decisions stored by an earlier version, as flag patches: keeping a frame was picking it. */
export function parseLegacyDecisions(raw: string | null): Record<string, MarksPatch> {
  try {
    const value = JSON.parse(raw ?? '{}') as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, MarksPatch> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === 'keep') out[k] = { flag: 'pick' };
      else if (v === 'reject') out[k] = { flag: 'reject' };
    }
    return out;
  } catch {
    return {};
  }
}

export function loadLegacyDecisions(folder: string): Record<string, MarksPatch> {
  try {
    return parseLegacyDecisions(localStorage.getItem(LEGACY_PREFIX + folder));
  } catch {
    return {};
  }
}

export function clearLegacyDecisions(folder: string): void {
  try {
    localStorage.removeItem(LEGACY_PREFIX + folder);
  } catch {
    // Nothing to clear.
  }
}
