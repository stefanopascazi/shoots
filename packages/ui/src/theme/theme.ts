import { useCallback, useEffect, useState } from 'preact/hooks';

export type ThemePreference = 'system' | 'dark' | 'light';

const STORAGE_KEY = 'sh-theme';

/** Reads a stored preference; anything unknown falls back to following the OS. */
export function parseThemePreference(raw: string | null | undefined): ThemePreference {
  return raw === 'dark' || raw === 'light' ? raw : 'system';
}

/** Applies a preference to <html>: "system" removes the override so the media query decides. */
export function applyTheme(pref: ThemePreference, root: HTMLElement = document.documentElement): void {
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
}

function readStored(): ThemePreference {
  try {
    return parseThemePreference(localStorage.getItem(STORAGE_KEY));
  } catch {
    return 'system';
  }
}

/** Theme preference, persisted per browser and applied to the document. */
export function useTheme(): [ThemePreference, (pref: ThemePreference) => void] {
  const [pref, setPref] = useState<ThemePreference>(readStored);

  useEffect(() => applyTheme(pref), [pref]);

  const update = useCallback((next: ThemePreference) => {
    setPref(next);
    try {
      if (next === 'system') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable (private mode); the choice still applies for this page.
    }
  }, []);

  return [pref, update];
}
