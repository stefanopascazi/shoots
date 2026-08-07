/**
 * `shoots release-notes`: which migration notes this machine still owes.
 *
 * The selection rule is the whole command — a note for version V applies to an
 * artefact built by F when F < V <= running — so it is tested against the real
 * MIGRATIONS list as well as against synthetic stamps.
 */
import { describe, expect, test } from 'bun:test';
import { MIGRATIONS, type Migration } from '../../src/release-notes/migrations.js';
import { outstandingMigrations, selectMigrations } from '../../src/release-notes/select.js';
import { renderMigration, renderReport, wrap } from '../../src/release-notes/render.js';
import type { ArtifactStamp } from '../../src/release-notes/artifacts.js';

const stamp = (kind: 'profile' | 'dataset', version: string | null): ArtifactStamp => ({
  kind,
  path: `/home/.shoots/develop/${kind}`,
  version,
});

const migration = (over: Partial<Migration> = {}): Migration => ({
  version: '9.9.9',
  title: 'Do the thing',
  required: true,
  affects: ['profile'],
  summary: 'Something changed.',
  steps: ['shoots develop train'],
  notes: [],
  ...over,
});

describe('MIGRATIONS', () => {
  test('is ordered oldest to newest', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect([...versions].sort()).toEqual([...versions]);
  });

  test('declares one version at most once', () => {
    expect(new Set(MIGRATIONS.map((m) => m.version)).size).toBe(MIGRATIONS.length);
  });

  test('every required note tells the photographer what to run', () => {
    for (const m of MIGRATIONS) {
      if (m.required) expect(m.steps.length).toBeGreaterThan(0);
    }
  });

  test('a note that asks nothing of stored state affects nothing', () => {
    for (const m of MIGRATIONS) {
      if (!m.required && m.steps.length === 0) expect(m.affects.length).toBe(0);
    }
  });
});

describe('selectMigrations', () => {
  test('returns notes strictly after `from` and up to `to`', () => {
    const picked = selectMigrations('0.5.0', '0.6.0').map((m) => m.version);
    expect(picked).toEqual(['0.6.0']);
  });

  test('treats a missing `from` as "older than everything"', () => {
    expect(selectMigrations(null, '0.7.0').length).toBe(
      MIGRATIONS.filter((m) => m.version <= '0.7.0').length,
    );
  });

  test('hides notes newer than the running build', () => {
    expect(selectMigrations(null, '0.5.0').map((m) => m.version)).toEqual(['0.5.0']);
  });

  test('is empty when the artefact is already current', () => {
    const newest = MIGRATIONS[MIGRATIONS.length - 1]!.version;
    expect(selectMigrations(newest, newest)).toEqual([]);
  });

  // Un-built sources report 0.0.0-dev, which orders below every release — the
  // one place the whole list would otherwise disappear is where it is authored.
  test('shows everything when running from an un-built source tree', () => {
    expect(selectMigrations(null, '0.0.0-dev').length).toBe(MIGRATIONS.length);
  });

  test('returns them newest last', () => {
    const picked = selectMigrations(null, '0.7.0');
    for (let i = 1; i < picked.length; i++) {
      expect(picked[i]!.version > picked[i - 1]!.version).toBe(true);
    }
  });
});

describe('outstandingMigrations', () => {
  test('reports nothing when this machine holds no artefacts', () => {
    expect(outstandingMigrations([], '0.7.0')).toEqual([]);
  });

  test('reports only notes that touch the kind of artefact present', () => {
    // 0.6.0 affects the profile alone: a machine with only a dataset is not stale.
    const forDataset = outstandingMigrations([stamp('dataset', '0.5.0')], '0.6.0');
    expect(forDataset).toEqual([]);

    const forProfile = outstandingMigrations([stamp('profile', '0.5.0')], '0.6.0');
    expect(forProfile.map((o) => o.migration.version)).toEqual(['0.6.0']);
  });

  test('lists every stale artefact under the one note', () => {
    const [entry] = outstandingMigrations([stamp('profile', null), stamp('dataset', null)], '0.5.0');
    expect(entry!.migration.version).toBe('0.5.0');
    expect(entry!.staleArtifacts.map((a) => a.kind).sort()).toEqual(['dataset', 'profile']);
  });

  test('says nothing when everything was built by the running version', () => {
    expect(outstandingMigrations([stamp('profile', '0.7.0'), stamp('dataset', '0.7.0')], '0.7.0')).toEqual([]);
  });

  test('an unstamped artefact predates every note', () => {
    const versions = outstandingMigrations([stamp('profile', null)], '0.7.0').map((o) => o.migration.version);
    expect(versions).toEqual(
      MIGRATIONS.filter((m) => m.affects.includes('profile')).map((m) => m.version),
    );
  });

  test('orders the result oldest first, so the steps can be run in sequence', () => {
    const versions = outstandingMigrations([stamp('profile', null)], '0.7.0').map((o) => o.migration.version);
    expect([...versions].sort()).toEqual(versions);
  });
});

describe('wrap', () => {
  test('breaks at word boundaries within the limit', () => {
    const lines = wrap('one two three four five', '', 20);
    expect(lines).toEqual(['one two three four', 'five']);
    expect(lines.every((l) => l.length <= 20)).toBe(true);
  });

  test('floors the usable width at 20 columns, however narrow it is asked to be', () => {
    expect(wrap('one two three four five', '', 5)).toEqual(['one two three four', 'five']);
  });

  test('applies the indent to every line and charges it against the width', () => {
    const lines = wrap('aaa bbb ccc', '>> ', 24);
    expect(lines.every((l) => l.startsWith('>> '))).toBe(true);
  });

  test('leaves a long token intact rather than splitting a path', () => {
    const long = 'C:/photos/2026/2026-08-02/a-very-long-file-name.cr3';
    expect(wrap(`see ${long} now`, '', 20)).toContain(long);
  });

  test('collapses runs of whitespace', () => {
    expect(wrap('a   b\n\nc', '', 40)).toEqual(['a b c']);
  });

  test('returns nothing for empty text', () => {
    expect(wrap('   ')).toEqual([]);
  });

  test('never lets the indent squeeze the width below a usable minimum', () => {
    expect(wrap('word', ' '.repeat(200), 78).length).toBe(1);
  });
});

describe('renderMigration', () => {
  test('leads with the verdict, then the steps', () => {
    const lines = renderMigration(migration(), [stamp('profile', '0.5.0')]);
    expect(lines[0]).toBe('9.9.9 — Do the thing');
    expect(lines[1]).toBe('  ACTION REQUIRED');
    expect(lines.some((l) => l.includes('affects: profile (built by 0.5.0)'))).toBe(true);
    expect(lines).toContain('  Do this:');
    expect(lines).toContain('    $ shoots develop train');
  });

  test('marks an optional note as informational', () => {
    expect(renderMigration(migration({ required: false, steps: [] }), [])[1]).toBe('  informational');
  });

  test('dates an unstamped artefact rather than showing a blank', () => {
    const lines = renderMigration(migration(), [stamp('profile', null)]);
    expect(lines.some((l) => l.includes('built by 0.4.8 or earlier'))).toBe(true);
  });

  test('omits the affects line when nothing on this machine is stale', () => {
    expect(renderMigration(migration(), []).some((l) => l.includes('affects:'))).toBe(false);
  });

  test('bullets every note', () => {
    const lines = renderMigration(migration({ notes: ['first note', 'second note'] }), []);
    expect(lines.filter((l) => l.startsWith('  · ')).length).toBe(2);
  });
});

describe('renderReport', () => {
  test('points a first-time user at develop init', () => {
    const out = renderReport('0.7.0', [], []).join('\n');
    expect(out).toContain('nothing to migrate');
    expect(out).toContain('shoots develop init');
  });

  test('lists what is on the machine and says when it is current', () => {
    const artifacts = [stamp('profile', '0.7.0')];
    const out = renderReport('0.7.0', [], artifacts).join('\n');
    expect(out).toContain('profile');
    expect(out).toContain('built by 0.7.0');
    expect(out).toContain('Nothing to do');
  });

  test('warns loudly, and in the singular, for one required step', () => {
    const artifacts = [stamp('profile', '0.5.0')];
    const outstanding = outstandingMigrations(artifacts, '0.6.0');
    const out = renderReport('0.6.0', outstanding, artifacts).join('\n');

    expect(out).toContain('A required step is outstanding');
    expect(out).toContain('will refuse to run until it is done');
    expect(out).toContain('Run the steps above, in order');
  });

  test('pluralizes when several are outstanding', () => {
    const artifacts = [stamp('profile', null)];
    const outstanding = outstandingMigrations(artifacts, '0.7.0');
    const out = renderReport('0.7.0', outstanding, artifacts).join('\n');
    expect(out).toMatch(/\d+ required steps are outstanding/);
  });

  test('stays quiet about a purely informational note', () => {
    const artifacts = [stamp('profile', '0.7.0')];
    const outstanding = [{ migration: migration({ required: false, steps: [] }), staleArtifacts: artifacts }];
    const out = renderReport('0.7.0', outstanding, artifacts).join('\n');

    expect(out).not.toContain('ACTION REQUIRED');
    expect(out).toContain('1 note since these were built.');
  });
});
