/**
 * `develop feedback` — what the photographer changed after we predicted.
 *
 * Every number this tool reports about itself is cross-validated on the catalog
 * it was fitted from. That answers "would this have matched an edit you already
 * made", which is a proxy, and a strict one, but a proxy. The question the tool
 * exists to answer is different: **when I hand you a starting point, how much of
 * it do you keep?**
 *
 * That is measurable, and only here. `predict` records what it proposed; the
 * sidecars then go through Lightroom and come back carrying whatever the
 * photographer decided. The difference between the two is the only real-world
 * error signal in the whole pipeline — and it is worth more per sample than a
 * fresh catalog edit, because it isolates *our* mistake rather than their style.
 *
 * Three things come out of it:
 *
 *  - **Acceptance.** The share of predicted parameters left untouched. This is
 *    the product metric; held-out skill is its proxy.
 *  - **Bias.** The mean *signed* correction. A parameter everyone nudges the
 *    same way is not a modelling failure, it is an offset — and an offset is
 *    fixable without a model.
 *  - **Spread.** The mean absolute correction, in the units on the slider.
 *
 * One shoot rarely carries enough images to say any of that per parameter, so
 * every run is also written to the journal (see feedback/journal.ts) and the
 * breakdown is computed over everything recorded so far. A photographer who
 * shoots eight frames at a time still gets an answer; it just takes six months
 * instead of one afternoon.
 *
 * `refresh-targets` cannot do this. It rebuilds a dataset to match the files as
 * they are now, which throws away exactly the thing that matters here: what they
 * were before the photographer touched them.
 *
 * One honest limit, stated in the report rather than buried: this compares a
 * prediction against whatever the file says today. If the sidecar was never
 * imported and the photograph was edited from scratch, the "correction" measures
 * the distance between two independent opinions, not our error. The tool cannot
 * tell those apart, and says so.
 */
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { developFeedbackPath } from '@shoots/core';
import { withCurveTargets } from '../develop/schema.js';
import { DEFAULT_EDITOR, EDITOR_IDS, resolveAdapter } from '../adapters/registry.js';
import { loadJournal, recordObservations, shootCount, type FeedbackObservation } from '../feedback/journal.js';
import { RELIABLE_SAMPLE, buildObservation, minMovedFloor, summarize, type FeedbackSummary } from '../feedback/stats.js';
import { startPhase } from '../../progress.js';
import { logError, makeIo, printHuman, printJson } from '../../io.js';
import { ensureExiftoolReady } from '../../tools.js';
import type { Prediction } from '../predict.js';

export interface FeedbackArgs {
  predictions: string;
  editor?: string;
  /** Write this run's (predicted, actual) pairs here for later use. */
  out?: string;
  /** Journal path, or `false` to measure this run without recording it. */
  journal?: string | boolean;
  /** Comparisons a parameter needs before it is listed (default: scaled to the pool). */
  minMoved?: number;
  json?: boolean;
  verbose?: boolean;
}

export async function runFeedback(args: FeedbackArgs): Promise<void> {
  const io = makeIo(args);
  const editorId = args.editor ?? DEFAULT_EDITOR;
  if (!EDITOR_IDS.includes(editorId)) {
    logError(`unknown --editor '${editorId}' (available: ${EDITOR_IDS.join(', ')})`);
    process.exitCode = 2;
    return;
  }
  const adapter = resolveAdapter(editorId);

  const payload = JSON.parse(await readFile(args.predictions, 'utf8')) as {
    command?: string;
    predictions?: Prediction[];
  };
  const predictions = payload.predictions ?? [];
  if (predictions.length === 0) {
    logError(`${args.predictions}: no predictions found (expected the JSON written by \`develop predict --out\`)`);
    process.exitCode = 2;
    return;
  }
  if (!(await ensureExiftoolReady(io))) return;

  const files = predictions.map((p) => p.file);
  const phase = startPhase(io, 'Reading current develop settings');
  const edits = await adapter.readEdits(files, io, (done, total) => phase.update(`${done}/${total}`));
  phase.done(`${files.length} files`);

  const at = new Date().toISOString();
  const run = path.resolve(args.predictions);
  const observations: FeedbackObservation[] = [];
  let missing = 0;

  for (const prediction of predictions) {
    const edit = edits.get(prediction.file);
    if (!edit || Object.keys(edit.develop).length === 0) {
      missing++;
      continue;
    }
    // The curve lives in its own tag, so lift it into the same per-knot keys the
    // prediction speaks before comparing.
    observations.push(
      buildObservation(prediction, withCurveTargets(edit.develop, edit.curve), {
        at,
        run,
        render: { profile: edit.baseProfile, look: edit.look },
      }),
    );
  }

  if (observations.length === 0) {
    logError('none of the predicted files carry develop settings today — nothing to compare against');
    process.exitCode = 2;
    return;
  }

  const shoot = summarize(observations);

  // The journal is what makes a small shoot readable, so it is on by default and
  // opting out is explicit. Its pool includes this run, whether or not the run
  // was the first one.
  const journalPath = args.journal === false ? null : typeof args.journal === 'string' ? path.resolve(args.journal) : developFeedbackPath();
  let pool = observations;
  let recorded = false;
  if (journalPath) {
    try {
      pool = await recordObservations(journalPath, observations);
      recorded = true;
    } catch (err) {
      logError(`could not write the journal at ${journalPath}: ${err instanceof Error ? err.message : String(err)}`);
      pool = [...(await loadJournal(journalPath)), ...observations];
    }
  }
  const cumulative = pool.length > observations.length ? summarize(pool) : shoot;
  const table = pool.length > observations.length ? cumulative : shoot;
  const minMoved = args.minMoved ?? minMovedFloor(table.images);

  if (args.out) {
    await writeFile(args.out, observations.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8');
  }

  if (io.json) {
    printJson({
      command: 'develop-feedback',
      images: { predicted: predictions.length, compared: observations.length, notEditedYet: missing, untouched: shoot.untouched },
      acceptance: shoot.acceptance,
      engagedAcceptance: shoot.engagedAcceptance,
      params: shoot.params,
      journal: journalPath
        ? {
            path: journalPath, recorded, images: cumulative.images, shoots: shootCount(pool),
            acceptance: cumulative.acceptance, engagedAcceptance: cumulative.engagedAcceptance,
            params: cumulative.params,
          }
        : null,
      minMoved,
    });
    return;
  }

  report(shoot, cumulative, table, {
    predicted: predictions.length,
    missing,
    minMoved,
    journalPath: recorded ? journalPath : null,
    shoots: shootCount(pool),
  });
  if (args.out) printHuman(io, `\nWrote this run's pairs to ${args.out}`);
}

interface ReportContext {
  predicted: number;
  missing: number;
  minMoved: number;
  journalPath: string | null;
  shoots: number;
}

function report(shoot: FeedbackSummary, cumulative: FeedbackSummary, table: FeedbackSummary, ctx: ReportContext): void {
  const w = process.stderr;
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

  w.write(`\nFeedback on ${shoot.images} of ${ctx.predicted} predicted images\n`);
  if (ctx.missing > 0) w.write(`  ${ctx.missing} carry no develop settings yet — not compared\n`);
  w.write(`  ${shoot.untouched} accepted with no change at all\n\n`);

  w.write(`  this shoot  kept ${pct(shoot.engagedAcceptance)} of the parameters either of us moved\n`);
  w.write(`              (${pct(shoot.acceptance)} counting the sliders we both left at neutral —\n`);
  w.write(`               that number flatters the model and is not the one to quote)\n`);
  const cumulated = cumulative !== shoot;
  if (cumulated) {
    w.write(`  journal     kept ${pct(cumulative.engagedAcceptance)} over ${cumulative.images} images from ${ctx.shoots} shoots\n`);
  }
  w.write('\n');

  // Enough comparisons to mean something, worst journey first: that is the list
  // worth acting on. Rows a small pool only just clears are marked, not hidden —
  // see minMovedFloor.
  const worst = table.params.filter((r) => r.engaged >= ctx.minMoved).sort((a, b) => a.journey - b.journey);
  w.write(`  over ${cumulated ? `the journal (${table.images} images)` : 'this shoot'}, ` +
    `listed from ${ctx.minMoved} comparisons up:\n\n`);
  w.write('  param                           moved   kept   journey   corrected by   offset\n');
  for (const r of worst.slice(0, 25)) {
    const keptPct = `${((r.engagedKept / r.engaged) * 100).toFixed(0)}%`;
    const sign = r.bias >= 0 ? '+' : '';
    const thin = r.engaged < RELIABLE_SAMPLE ? '·' : ' ';
    w.write(
      `  ${r.key.padEnd(30)} ${String(r.engaged).padStart(4)}${thin} ${keptPct.padStart(6)} ` +
        `${(r.journey * 100).toFixed(0).padStart(8)}% ${r.spread.toFixed(2).padStart(14)} ` +
        `${(sign + r.bias.toFixed(2)).padStart(8)}\n`,
    );
  }
  if (worst.length === 0) w.write('  (nothing yet — no parameter has been moved on enough images)\n');
  if (worst.length > 25) w.write(`  … ${worst.length - 25} more (pass --json for all)\n`);
  const skipped = table.params.filter((r) => r.engaged > 0 && r.engaged < ctx.minMoved).length;
  if (skipped > 0) w.write(`  (${skipped} parameters moved on fewer than ${ctx.minMoved} images — too few to read)\n`);
  if (worst.some((r) => r.engaged < RELIABLE_SAMPLE)) {
    w.write(`  · = fewer than ${RELIABLE_SAMPLE} comparisons: directional, not yet a rate.\n`);
  }

  w.write('\n  "kept" is the real product metric — held-out skill is only its proxy.\n');
  w.write('  "journey" is how much of the move the prediction already made for you;\n');
  w.write('  negative means it landed further off than leaving the slider alone.\n');
  w.write('  A large offset with a small spread is not a modelling failure: it is a\n');
  w.write('  constant this profile is missing, and a constant is easy to fix.\n');
  if (ctx.journalPath) {
    w.write(`\n  Recorded in ${ctx.journalPath}. Every shoot you run this on sharpens\n`);
    w.write('  the table above; `develop clean` never touches it.\n');
  }
  w.write('\n  This compares a prediction against what the file says today. If a sidecar\n');
  w.write('  was never imported and the photograph was edited from scratch, the gap is\n');
  w.write('  two independent opinions rather than our error — the tool cannot tell.\n');
}
