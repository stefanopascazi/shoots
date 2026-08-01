/**
 * Hand-authored migration notes, one entry per release that asks something of
 * the photographer.
 *
 * This is the *source of truth*, not `docs/migrations.md` — the standalone
 * binary carries no `docs/` directory, so anything the command must print at
 * runtime has to be compiled in. `scripts/generate-migrations-doc.mjs` renders
 * this list into `docs/migrations.md` for the site; never edit that file by hand.
 *
 * Deliberately not derived from the commit history: git-cliff already lists
 * *what changed*, and **what the user must do about it cannot be derived from
 * any commit**. That half is written here, per version, by hand.
 */

export interface Migration {
  /** The release that introduced the change (semver, no `v` prefix). */
  version: string;
  /** One line, imperative mood, shown as the entry's heading. */
  title: string;
  /** True when the photographer must act before the tool works again. */
  required: boolean;
  /** Stored artefacts under `~/.shoots` that this release invalidates. */
  affects: ReadonlyArray<'profile' | 'dataset'>;
  /** One paragraph: what changed, in the photographer's terms. */
  summary: string;
  /** The commands to run, in order. Empty when `required` is false. */
  steps: ReadonlyArray<string>;
  /** Anything worth knowing after the fact — why, and what cannot be salvaged. */
  notes: ReadonlyArray<string>;
}

/** Ordered oldest → newest; {@link selectMigrations} does the filtering. */
export const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: '0.5.0',
    title: 'Re-run `develop init`: the colour features widened from 44 to 50',
    required: true,
    affects: ['profile', 'dataset'],
    summary:
      'The develop predictor learned six new photometric features (lumaP01, lumaP99, ' +
      'shadowFloor, detailFine, detailCoarse, darkChannel) and now reads the capture ' +
      'hour out of the EXIF. Every profile and dataset built before this release ' +
      'describes an image with a narrower vector than the tool now produces, so ' +
      '`develop predict` and `develop learn` refuse them rather than predict from a ' +
      'feature space the model never saw.',
    steps: ['shoots develop init <your-edited-catalog>'],
    notes: [
      'Nothing can be salvaged. `develop refresh-targets` does not help: the features ' +
        'changed, not the targets.',
      'The stored format did not change — SCHEMA_VERSION stays at 8 on purpose, only ' +
        'the width of the vector moved.',
      'Your feedback journal (`develop feedback`) survives the rebuild; re-run ' +
        '`develop calibrate` afterwards to re-measure the offsets against the new model.',
    ],
  },
];
