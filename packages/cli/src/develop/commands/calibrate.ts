/**
 * `develop calibrate` — fold the journal's corrections back into the profile.
 *
 * The loop closes here. `edit` proposes, the photographer corrects, `feedback`
 * records, and this turns the record into a per-parameter offset the next
 * prediction carries. It is the only step that improves the profile from
 * evidence the catalog does not contain.
 *
 * Deliberately a separate command, and deliberately not run for you. It changes
 * what every future prediction says, and a tool that quietly rewrites its own
 * model between two runs of the same command is one nobody can debug. `--dry-run`
 * shows the whole decision; `--reset` takes it back.
 *
 * The estimator, and why it only ever proposes a constant, is in
 * feedback/calibrate.ts — that reasoning is the substance of this feature.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { developFeedbackPath, developProfilePath } from '@shoots/core';
import { DEVELOP_PARAMS, type Treatment } from '../develop/schema.js';
import { loadJournal, shootCount } from '../feedback/journal.js';
import {
  DEFAULT_MIN_SHOOTS,
  DEFAULT_SHRINK,
  estimateOffsets,
  fromOurSidecar,
  heldOut,
  renderKnown,
  type CalibrationEstimate,
} from '../feedback/calibrate.js';
import { logError, logWarn, makeIo, printHuman, printJson } from '../../io.js';
import type { DevelopCalibration, DevelopProfile } from '../types.js';

export interface CalibrateArgs {
  /** Profile to calibrate (default: the one `develop init` wrote). */
  profile?: string;
  journal?: string;
  /** Fraction of the measured correction to apply. */
  shrink?: number;
  /** Shoots a parameter needs before it is offset at all. */
  minShoots?: number;
  /** Calibrate on shoots already folded into training too — optimistic, and says so. */
  includeTrained?: boolean;
  /** Only use observations whose rendering still matches what `predict` wrote. */
  importedOnly?: boolean;
  /** Remove any calibration and leave the model as trained. */
  reset?: boolean;
  dryRun?: boolean;
  json?: boolean;
  verbose?: boolean;
}

const TREATMENTS: Treatment[] = ['color', 'bw'];
const GROUP = new Map(DEVELOP_PARAMS.map((p) => [p.key, p.group]));

/** Written through a temp file: a half-written profile is a broken install. */
async function writeProfile(file: string, profile: DevelopProfile): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(profile, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

export async function runCalibrate(args: CalibrateArgs): Promise<void> {
  const io = makeIo(args);
  const profilePath = path.resolve(args.profile ?? developProfilePath());
  if (!existsSync(profilePath)) {
    logError(`no profile at ${profilePath} — run \`shoots develop init <catalog>\` first, or pass --profile`);
    process.exitCode = 2;
    return;
  }
  const profile = JSON.parse(await readFile(profilePath, 'utf8')) as DevelopProfile;

  if (args.reset) {
    if (!profile.calibration) {
      printHuman(io, 'That profile carries no calibration — nothing to reset.');
      return;
    }
    if (!args.dryRun) {
      delete profile.calibration;
      await writeProfile(profilePath, profile);
    }
    if (io.json) printJson({ command: 'develop-calibrate', reset: true, dryRun: !!args.dryRun, profile: profilePath });
    else printHuman(io, args.dryRun ? 'Dry run — the calibration would be removed.' : 'Calibration removed; the model is as trained.');
    return;
  }

  const journalPath = path.resolve(args.journal ?? developFeedbackPath());
  const journal = await loadJournal(journalPath);
  if (journal.length === 0) {
    logError(
      `${journalPath} holds no observations yet — develop a shoot, then run ` +
        '`shoots develop feedback --predictions …` to record what you kept',
    );
    process.exitCode = 2;
    return;
  }

  // Observations whose rendering no longer matches the one we wrote were
  // developed from a different starting point, so their "correction" is measured
  // against something we never predicted for. Always counted, only excluded on
  // request: a photographer may have changed the base profile on purpose.
  const known = renderKnown(journal);
  const ours = fromOurSidecar(journal);
  // Shoots already folded into training cannot measure the model's error: it was
  // fitted on their answers. They stay in the journal and out of the estimate.
  const usable = args.includeTrained ? journal : heldOut(journal);
  const burned = journal.length - heldOut(journal).length;
  const pool = args.importedOnly ? usable.filter((o) => ours.includes(o)) : usable;
  if (pool.length === 0) {
    logError(
      burned > 0 && !args.includeTrained
        ? `all ${burned} observations have been folded into training by \`develop learn\`, so none of them can ` +
            'measure this model any more — develop another shoot and run `develop feedback` first ' +
            '(or --include-trained to calibrate on them anyway, knowing the estimate flatters the model)'
        : '--imported-only left no observations: none of the journal still carries the rendering `predict` wrote',
    );
    process.exitCode = 2;
    return;
  }

  const shrink = args.shrink ?? DEFAULT_SHRINK;
  const minShoots = args.minShoots ?? DEFAULT_MIN_SHOOTS;
  const estimates = TREATMENTS.filter((t) => profile.branches[t]).map((t) =>
    estimateOffsets(pool, t, { shrink, minShoots }),
  );

  const calibration: DevelopCalibration = {
    at: new Date().toISOString(),
    profileTrainedAt: profile.trainedAt,
    images: Object.fromEntries(estimates.map((e) => [e.treatment, e.images])),
    shoots: Object.fromEntries(estimates.map((e) => [e.treatment, e.shoots])),
    shrink,
    offsets: Object.fromEntries(estimates.map((e) => [e.treatment, e.offsets])),
  };
  const total = estimates.reduce((a, e) => a + Object.keys(e.offsets).length, 0);

  if (!args.dryRun && total > 0) {
    profile.calibration = calibration;
    await writeProfile(profilePath, profile);
  }
  if (!args.dryRun && total === 0 && profile.calibration) {
    logWarn('nothing cleared the gates this time; the profile keeps the calibration it already had');
  }

  if (io.json) {
    printJson({
      command: 'develop-calibrate',
      dryRun: !!args.dryRun,
      profile: profilePath,
      journal: {
        path: journalPath, images: journal.length, shoots: shootCount(journal),
        renderKnown: known.length, fromOurSidecar: ours.length,
        trainedOn: burned, usable: pool.length,
      },
      applied: !args.dryRun && total > 0,
      shrink,
      minShoots,
      calibration,
      params: Object.fromEntries(estimates.map((e) => [e.treatment, e.params])),
    });
    return;
  }

  report(estimates, {
    profilePath, journalPath, shrink, minShoots, total,
    journalImages: journal.length, shoots: shootCount(journal),
    known: known.length, ours: ours.length, burned,
    importedOnly: !!args.importedOnly, dryRun: !!args.dryRun,
    previous: profile.calibration?.at,
  });
}

interface ReportContext {
  profilePath: string;
  journalPath: string;
  shrink: number;
  minShoots: number;
  total: number;
  journalImages: number;
  shoots: number;
  known: number;
  ours: number;
  burned: number;
  importedOnly: boolean;
  dryRun: boolean;
  previous?: string;
}

function report(estimates: CalibrationEstimate[], ctx: ReportContext): void {
  const w = process.stderr;
  w.write(`\nCalibrating ${ctx.profilePath}\n`);
  w.write(`  journal: ${ctx.journalImages} images from ${ctx.shoots} shoots\n`);
  if (ctx.burned > 0) {
    w.write(`  ${ctx.burned} already folded into training by \`develop learn\` — excluded, the model has seen them\n`);
  }
  if (ctx.known > 0) {
    const pct = ((ctx.ours / ctx.known) * 100).toFixed(0);
    w.write(`  ${ctx.ours}/${ctx.known} still carry the rendering we wrote (${pct}% — evidence the sidecars were imported)\n`);
    if (ctx.importedOnly) w.write('  --imported-only: the rest are excluded\n');
  }
  w.write(`  applying ${(ctx.shrink * 100).toFixed(0)}% of each measured correction, from ${ctx.minShoots} shoots up\n`);

  for (const estimate of estimates) {
    const taken = estimate.params.filter((p) => !p.rejected).sort((a, b) => Math.abs(b.offset) - Math.abs(a.offset));
    w.write(`\n  ${estimate.treatment} — ${estimate.images} images across ${estimate.shoots} shoots, ${taken.length} parameters offset\n`);
    if (taken.length === 0) {
      const tooFew = estimate.params.filter((p) => p.rejected === 'too-few').length;
      const noLean = estimate.params.filter((p) => p.rejected === 'no-direction').length;
      if (estimate.shoots < ctx.minShoots) {
        w.write(`    ${estimate.shoots} shoot(s) is not enough to tell a habit from a job — ${ctx.minShoots} is the floor,\n`);
        w.write('    because three shoots agreeing unanimously still only reach 1.7 sigma.\n');
      } else {
        w.write(`    nothing leans consistently across shoots (${noLean} disagree between jobs, ${tooFew} seen too rarely)\n`);
      }
      continue;
    }
    w.write('    param                        shoots   up/down   sigma   measured   applied\n');
    for (const p of taken.slice(0, 20)) {
      const sign = (x: number): string => (x >= 0 ? '+' : '') + x.toFixed(2);
      w.write(
        `    ${p.key.padEnd(30)} ${String(p.shoots).padStart(3)} ${`${p.up}/${p.down}`.padStart(9)} ` +
          `${p.sigma.toFixed(1).padStart(7)} ${sign(p.measured).padStart(10)} ${sign(p.offset).padStart(9)}` +
          `${GROUP.get(p.key) === 'wb' ? '  (log)' : ''}\n`,
      );
    }
    if (taken.length > 20) w.write(`    … ${taken.length - 20} more (pass --json for all)\n`);
  }

  w.write('\n  One shoot is one vote, however many photographs it holds: a take edited by\n');
  w.write('  pasting settings across it is a single decision, not four hundred.\n');
  w.write('  An offset is what the model is reliably wrong by in one direction — a\n');
  w.write('  constant it never learned. It is applied on top of the prediction and\n');
  w.write('  stored beside the model, not merged into it: `--reset` takes it back.\n');
  w.write('  Only half of each measured correction is applied, so calibrating again\n');
  w.write('  after the next shoot converges rather than overshoots.\n');
  if (ctx.previous) w.write(`\n  Replaces the calibration from ${ctx.previous}.\n`);
  if (ctx.dryRun) {
    w.write('\nDry run — the profile was not touched. Re-run without --dry-run to apply.\n');
  } else if (ctx.total > 0) {
    w.write(`\nWritten. The next \`shoots develop edit\` carries ${ctx.total} offsets.\n`);
  } else {
    w.write('\nNothing to apply yet — record more shoots with `shoots develop feedback`.\n');
  }
}
