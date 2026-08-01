/**
 * Which migration notes still apply to this machine.
 *
 * A note for version V is outstanding for an artefact built by version F when
 * F < V <= running. An artefact with no recorded version predates every note
 * (see artifacts.ts), so all of them apply to it.
 */
import { compareSemver } from '@shoots/core';
import { MIGRATIONS, type Migration } from './migrations.js';
import type { ArtifactStamp } from './artifacts.js';

/**
 * Un-built sources report `0.0.0-dev`, which would order *below* every release
 * and hide the whole list exactly where it is being developed. Treat it as
 * "newer than anything published" instead.
 */
const DEV_VERSION = '0.0.0-dev';

export interface OutstandingMigration {
  migration: Migration;
  /** The artefacts still built by a version older than this note. */
  staleArtifacts: ArtifactStamp[];
}

/** Notes introduced after `from` and no later than `to`. Newest last. */
export function selectMigrations(from: string | null, to: string): Migration[] {
  return MIGRATIONS.filter((m) => {
    if (from !== null && compareSemver(m.version, from) <= 0) return false;
    return to === DEV_VERSION || compareSemver(m.version, to) <= 0;
  }).sort((a, b) => compareSemver(a.version, b.version));
}

/**
 * Cross the notes with what is actually stored on this machine.
 *
 * A note nobody's artefacts are stale against is not reported: with no profile
 * and no dataset there is nothing to migrate, and telling a first-time user to
 * re-run `develop init` on a catalog they never built is noise.
 */
export function outstandingMigrations(stamps: ArtifactStamp[], running: string): OutstandingMigration[] {
  const byVersion = new Map<string, OutstandingMigration>();
  for (const stamp of stamps) {
    for (const migration of selectMigrations(stamp.version, running)) {
      if (!migration.affects.includes(stamp.kind)) continue;
      const entry = byVersion.get(migration.version) ?? { migration, staleArtifacts: [] };
      entry.staleArtifacts.push(stamp);
      byVersion.set(migration.version, entry);
    }
  }
  return [...byVersion.values()].sort((a, b) => compareSemver(a.migration.version, b.migration.version));
}
