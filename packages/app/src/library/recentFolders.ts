/** Recently opened folders, remembered per browser. A convenience: losing it costs nothing. */
const KEY = 'shoots-recent-folders';
export const MAX_RECENT = 6;

export function pushRecent(list: readonly string[], folder: string, max = MAX_RECENT): string[] {
  return [folder, ...list.filter((f) => f !== folder)].slice(0, max);
}

export function loadRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

export function saveRecent(list: readonly string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable: the list just is not remembered.
  }
}
