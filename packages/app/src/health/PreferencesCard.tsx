/** @jsxImportSource preact */
import { Card, Switch } from '@shoots/ui';
import type { SettingsHandle } from '../hooks/useSettings.js';

/** Choices that are not made in passing elsewhere in the app. */
export function PreferencesCard({ prefs }: { prefs: SettingsHandle }) {
  return (
    <Card title="Preferences" description="Saved on this computer, for every session.">
      <Switch checked={prefs.settings.reopenLastFolder} onChange={(v) => prefs.update({ reopenLastFolder: v })}>
        Reopen the last folder when the app starts
      </Switch>
    </Card>
  );
}
