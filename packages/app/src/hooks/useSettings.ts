import { useCallback, useState } from 'preact/hooks';
import { api } from '../api/client.js';
import type { AppSettings } from '../contract.js';

export interface SettingsHandle {
  settings: AppSettings;
  /** Applies at once and is saved in the background. */
  update: (patch: Partial<AppSettings>) => void;
}

/** Settings kept by the server, so they survive the browser, the tab and the app itself. */
export function useSettings(initial: AppSettings): SettingsHandle {
  const [settings, setSettings] = useState(initial);
  const update = useCallback((patch: Partial<AppSettings>) => {
    setSettings((s) => ({ ...s, ...patch }));
    // A failed save only costs the setting next time; the page goes on with it.
    void api.saveSettings(patch).catch(() => {});
  }, []);
  return { settings, update };
}
