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
  {
    version: '0.6.0',
    title: 'Retrain: the predictor now answers "what about THIS frame", not just "what about this shoot"',
    required: true,
    affects: ['profile'],
    summary:
      'Predictions used to come back nearly identical for every photograph in a shoot — ' +
      'a frame shot into the sun and one in open shade both got the same Highlights. ' +
      'That was real: one regression had to explain both where a shoot sits and how its ' +
      'frames differ, and the shoot average always won, leaving the per-frame evidence ' +
      'with a tenth of its honest weight. A profile is now two models added together — ' +
      'one reading the shoot, one reading only how far this frame departs from it — each ' +
      'kept or dropped on its own evidence, and each stretched back to the amplitude that ' +
      'evidence supports instead of collapsing onto your average. A profile from 0.5.0 ' +
      'has a single weight matrix over a layout that no longer exists.',
    steps: ['shoots develop train --data <your-export> --name <your-profile>'],
    notes: [
      'The export is unchanged — no re-export, and `develop train` alone is enough.',
      'The report gained an "in-shoot" column. That is the one to read when a prediction ' +
        'feels like a default: it measures whether the model tells two frames of the SAME ' +
        'shoot apart, which the headline number can look healthy without.',
      'On the reference catalog (428 colour frames, 32 shoots) the headline skill went ' +
        '0.020 → 0.057 and Highlights 14% → 20%, while the spread of predicted Highlights ' +
        'inside a shoot doubled. It is still below the photographer\'s own spread, and ' +
        'deliberately so — the model reaches as far as the evidence carries it and no further.',
      'Re-run `develop calibrate` afterwards: the offsets were measured against a model ' +
        'that no longer exists.',
    ],
  },
  {
    version: '0.7.0',
    title: 'Rename `--xmp` to `--sidecars` in your scripts (the old flag still works, and warns)',
    required: false,
    affects: [],
    summary:
      '`shoots develop predict --xmp <dir>` was named after the file it wrote, back when ' +
      'there was only one editor to write for. There are two now: `--editor rapidraw` ' +
      'emits `.rrdata` JSON, and a flag called `--xmp` producing something that is not ' +
      'XMP is a lie the next adapter would have to keep telling. It is `--sidecars <dir>` ' +
      'from this release, and the adapter decides the format and the filename.',
    steps: [],
    notes: [
      '`--xmp` still works. It prints a deprecation warning, is hidden from `--help`, and ' +
        'will be removed in a later release — nothing breaks today.',
      'Passing both is an error only when they name different directories, which is the ' +
        'one case where guessing would write your sidecars somewhere you did not ask for.',
      'Nothing stored changes: no profile, no dataset, no re-export, no retrain.',
      '`develop edit --dry-run --json` renamed the same key inside its plan, from `xmp` ' +
        'to `sidecars`. Only a script parsing that plan is affected.',
    ],
  },
];
