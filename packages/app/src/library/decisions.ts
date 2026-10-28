/**
 * The photographer's keep/reject decisions, per folder, remembered in this
 * browser so a reload or a re-run of the cull never loses them.
 */
import type { Decision, Decisions } from './model.js';

const PREFIX = 'shoots-decisions:';

/** A new record with `decision` set for `path`, or removed when undefined. */
export function withDecision(record: Decisions, path: string, decision: Decision | undefined): Decisions {
  const next = { ...record };
  if (decision) next[path] = decision;
  else delete next[path];
  return next;
}

export function parseDecisions(raw: string | null): Decisions {
  try {
    const value = JSON.parse(raw ?? '{}') as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, Decision> = {};
    for (const [k, v] of Object.entries(value)) if (v === 'keep' || v === 'reject') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export function loadDecisions(folder: string): Decisions {
  try {
    return parseDecisions(localStorage.getItem(PREFIX + folder));
  } catch {
    return {};
  }
}

export function saveDecisions(folder: string, record: Decisions): void {
  try {
    if (Object.keys(record).length === 0) localStorage.removeItem(PREFIX + folder);
    else localStorage.setItem(PREFIX + folder, JSON.stringify(record));
  } catch {
    // Storage unavailable: decisions last for this page only.
  }
}
