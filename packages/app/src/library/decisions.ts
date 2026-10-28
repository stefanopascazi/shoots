/**
 * Keep/reject decisions on the client side: the pure update, and the one-time
 * hand-over of decisions an earlier version kept in this browser. The server's
 * database is where they live now.
 */
import type { Decision, Decisions } from './model.js';

const LEGACY_PREFIX = 'shoots-decisions:';

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

export function loadLegacyDecisions(folder: string): Decisions {
  try {
    return parseDecisions(localStorage.getItem(LEGACY_PREFIX + folder));
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
