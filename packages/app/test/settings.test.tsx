/** @jsxImportSource preact */
import { describe, expect, test } from 'bun:test';
import { render } from 'preact-render-to-string';
import { initialSelection, itemFor, PARTS, size } from '../src/settings/cleanup.js';
import { CleanupCard } from '../src/settings/CleanupCard.js';
import { SettingsScreen } from '../src/settings/SettingsScreen.js';
import { HealthScreen } from '../src/health/HealthScreen.js';
import type { AppInfo } from '../src/contract.js';
import type { SettingsHandle } from '../src/hooks/useSettings.js';

describe('clean-up parts', () => {
  test('the journal is never preselected and says it cannot be rebuilt', () => {
    const journal = PARTS.find((p) => p.part === 'journal')!;
    expect(journal.preselected).toBe(false);
    expect(journal.irreplaceable).toBe(true);
  });

  test('only preselected parts holding something start ticked', () => {
    const items = [
      { part: 'dataset' as const, count: 1, bytes: 5 },
      { part: 'journal' as const, count: 1, bytes: 5 },
      { part: 'jobs' as const, count: 0, bytes: 0 },
    ];
    expect([...initialSelection(items)]).toEqual(['dataset']);
    expect(itemFor(items, 'exports')).toEqual({ part: 'exports', count: 0, bytes: 0 });
  });

  test('sizes read as a person would', () => {
    expect(size(0, 0)).toBe('nothing');
    expect(size(0, 1)).toBe('present');
    expect(size(340_000, 2)).toBe('340 kB');
    expect(size(1_200_000_000, 1)).toBe('1.2 GB');
  });
});

describe('CleanupCard', () => {
  test('lists every part before the sizes arrive', () => {
    const html = render(<CleanupCard />);
    for (const p of PARTS) expect(html).toContain(p.label);
    expect(html).toContain('Remove selected');
  });
});

describe('SettingsScreen', () => {
  test('holds preferences, app memory and the clean-up', () => {
    const prefs = { settings: { reopenLastFolder: true }, update: () => {} } as unknown as SettingsHandle;
    const html = render(<SettingsScreen prefs={prefs} />);
    for (const title of ['Settings', 'Preferences', 'App memory', 'Remove selected']) expect(html).toContain(title);
  });
});

describe('HealthScreen', () => {
  test('keeps only the checks and the installation facts', () => {
    const html = render(<HealthScreen info={{ version: '1.2.3', platform: 'win32', home: 'C:\h' } as AppInfo} />);
    expect(html).toContain('Checks');
    expect(html).toContain('This installation');
    expect(html).not.toContain('Preferences');
    expect(html).not.toContain('App memory');
  });
});
