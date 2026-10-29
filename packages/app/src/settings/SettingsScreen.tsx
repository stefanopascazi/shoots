/** @jsxImportSource preact */
import { PageHeader } from '@shoots/ui';
import type { SettingsHandle } from '../hooks/useSettings.js';
import { CleanupCard } from './CleanupCard.js';
import { MemoryCard } from './MemoryCard.js';
import { PreferencesCard } from './PreferencesCard.js';

/** Preferences, and what the app keeps on disk: clearing and cleaning it up. */
export function SettingsScreen({ prefs }: { prefs: SettingsHandle }) {
  return (
    <>
      <PageHeader title="Settings" description="Your preferences, and the data shoots keeps on this computer." />
      <div class="app-health">
        <div class="app-side">
          <PreferencesCard prefs={prefs} />
          <MemoryCard />
        </div>
        <CleanupCard />
      </div>
    </>
  );
}
