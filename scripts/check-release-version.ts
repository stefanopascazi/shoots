/**
 * Guards the version being cut against what the release actually does to the
 * photographer's data.
 *
 * The decision "patch or minor" is already made, by hand, somewhere else: a
 * release that invalidates a stored profile or dataset gets an entry in
 * `packages/cli/src/release-notes/migrations.ts`, and one that does not, does
 * not. This script is what ties that entry to the number — without it the two
 * drift, which is how a note announcing `0.6.0` shipped inside `v0.5.1` and was
 * then filtered out of `shoots release-notes` for fourteen releases: no note may
 * name a version newer than the running build, so it was never printed at all.
 *
 * Rules, for a 0.x project distributing a standalone binary:
 *   - a new migration note  -> minor (0.5.x -> 0.6.0), and the note must name it
 *   - anything else, features included -> patch
 *   - a note may never name a release that does not exist yet
 *
 * Runs from the `version` npm lifecycle, i.e. after package.json is bumped and
 * before the commit and tag exist. Failing here aborts `npm version` with the
 * bump already written to package.json — `git checkout package.json` to undo.
 *
 *   bun scripts/check-release-version.ts
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareSemver } from '../packages/core/src/semver.js';
import { MIGRATIONS } from '../packages/cli/src/release-notes/migrations.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type Level = 'major' | 'minor' | 'patch' | 'none';

function parts(version: string): [number, number, number] {
  const [a = 0, b = 0, c = 0] = version.replace(/^v/i, '').split(/[-+]/, 1)[0]!.split('.').map(Number);
  return [a, b, c];
}

function bumpLevel(from: string, to: string): Level {
  const [fromMajor, fromMinor, fromPatch] = parts(from);
  const [toMajor, toMinor, toPatch] = parts(to);
  if (toMajor !== fromMajor) return 'major';
  if (toMinor !== fromMinor) return 'minor';
  if (toPatch !== fromPatch) return 'patch';
  return 'none';
}

/** The newest released version, or null on a repo with no release tags yet. */
function latestTag(): string | null {
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: repo, encoding: 'utf8' })
    .split('\n')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .sort(compareSemver);
  return tags.at(-1)?.replace(/^v/i, '') ?? null;
}

const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')) as { version: string };
const next = pkg.version;
const previous = latestTag();

const errors: string[] = [];
const warnings: string[] = [];

// The list is documented as oldest → newest and `selectMigrations` keys on the
// version, so a duplicate would silently merge two notes into one.
for (let i = 1; i < MIGRATIONS.length; i += 1) {
  const [before, after] = [MIGRATIONS[i - 1]!, MIGRATIONS[i]!];
  if (compareSemver(before.version, after.version) >= 0) {
    errors.push(`MIGRATIONS is out of order or has a duplicate: ${before.version} then ${after.version}`);
  }
}

/** Notes this release introduces — the ones that decide the bump. */
const fresh = MIGRATIONS.filter((m) => previous === null || compareSemver(m.version, previous) > 0);
const misnamed = new Set(fresh.filter((m) => m.version !== next).map((m) => m.version));

// A note newer than the build can never be printed: `selectMigrations` drops
// everything above the running version. Skip the ones already reported below as
// naming the wrong release — same mistake, one message is enough.
for (const migration of MIGRATIONS.filter((m) => compareSemver(m.version, next) > 0)) {
  if (misnamed.has(migration.version)) continue;
  errors.push(
    `the ${migration.version} note is newer than the ${next} release being cut — ` +
      'no build will ever print it. Cut that version, or move the note to this one.',
  );
}

if (previous === null) {
  console.log('[release-version] no release tag yet — nothing to compare against');
} else if (compareSemver(next, previous) === 0) {
  // Only reachable by running this by hand after the release: `npm version`
  // refuses to re-set the version it is already on.
  console.log(`[release-version] ${next} is already tagged — nothing to cut`);
} else if (compareSemver(next, previous) < 0) {
  errors.push(`version ${next} is older than the last tag v${previous}`);
} else {
  const level = bumpLevel(previous, next);

  for (const migration of fresh.filter((m) => m.version !== next)) {
    errors.push(
      `the note added since v${previous} names ${migration.version}, but this release is ${next} — ` +
        'a note ships with the release that requires the work, or it is never printed.',
    );
  }

  if (fresh.length > 0 && level === 'patch') {
    const affects = [...new Set(fresh.flatMap((m) => m.affects))].join(' and ');
    errors.push(
      `this release invalidates the stored ${affects}, so it is not a patch — ` +
        'run `git checkout package.json && npm version minor`.',
    );
  }

  if (fresh.length === 0 && (level === 'minor' || level === 'major')) {
    warnings.push(
      `${next} is a ${level} bump with no migration note — if something the photographer has stops ` +
        'working, say so in packages/cli/src/release-notes/migrations.ts; if not, a patch is enough.',
    );
  }

  if (errors.length === 0) {
    const note = fresh.length > 0 ? `${fresh.length} migration note(s)` : 'no migration note';
    console.log(`[release-version] v${previous} → ${next} (${level}), ${note}`);
  }
}

for (const warning of warnings) console.warn(`[release-version] warning: ${warning}`);
for (const error of errors) console.error(`[release-version] ${error}`);
if (errors.length > 0) process.exit(1);
