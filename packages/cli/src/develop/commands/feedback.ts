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
import { readFile, writeFile } from 'node:fs/promises';
import { DEVELOP_PARAMS, curveParamKey, CURVE_KNOTS, withCurveTargets } from '../develop/schema.js';
import { DEFAULT_EDITOR, EDITOR_IDS, resolveAdapter } from '../adapters/registry.js';
import { startPhase } from '../../progress.js';
import { logError, makeIo, printHuman, printJson } from '../../io.js';
import { ensureExiftoolReady } from '../../tools.js';
import type { Prediction } from '../predict.js';

export interface FeedbackArgs {
  predictions: string;
  editor?: string;
  /** Write the (predicted, actual) pairs here for later use. */
  out?: string;
  json?: boolean;
  verbose?: boolean;
}

/**
 * How close counts as untouched.
 *
 * The sidecar writes most parameters as integers and exposure to two decimals,
 * so anything inside half a step is the same number that went out, not a
 * decision to leave it alone that happens to look like one.
 */
function tolerance(key: string): number {
  return key === 'Exposure2012' ? 0.005 : 0.5;
}

interface ParamFeedback {
  key: string;
  group: string;
  /** Images where both a prediction and a current value exist. */
  compared: number;
  /** …of those, how many the photographer left alone. */
  kept: number;
  /**
   * Comparisons where at least one side actually moved the slider.
   *
   * Agreeing that a slider stays at zero is not a prediction anyone made: most
   * parameters are gated to the photographer's mean, which is near neutral, and
   * counting those agreements put acceptance at 55% before this existed. The
   * honest denominator is the set where somebody had an opinion.
   */
  engaged: number;
  /** …of those, how many were left alone. */
  engagedKept: number;
  /** Mean signed correction (actual − predicted): a systematic offset. */
  bias: number;
  /** Mean absolute correction, in slider units. */
  spread: number;
  /**
   * How much of the slider's journey the prediction already covered:
   * `1 − |actual − predicted| / |actual − neutral|`.
   *
   * "Kept within half a unit" is the right bar for *accepted*, but it is a poor
   * description of a starting point. Landing at +38 where the photographer wants
   * +42 is not a hit, and it is not a miss either — it is most of the work done.
   * Negative means the prediction is further from the answer than doing nothing
   * would have been.
   */
  journey: number;
}

const CURVE_KEYS = new Set(CURVE_KNOTS.map(curveParamKey));

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

  const stats = new Map<string, {
    compared: number; kept: number; engaged: number; engagedKept: number; signed: number; absolute: number;
    /** Σ|actual − predicted| and Σ|actual − neutral| over engaged comparisons. */
    err: number; fromNeutral: number;
  }>();
  const pairs: unknown[] = [];
  let missing = 0;
  let untouchedImages = 0;

  for (const prediction of predictions) {
    const edit = edits.get(prediction.file);
    if (!edit || Object.keys(edit.develop).length === 0) {
      missing++;
      continue;
    }
    // The curve lives in its own tag, so lift it into the same per-knot keys the
    // prediction speaks before comparing.
    const actual = withCurveTargets(edit.develop, edit.curve);
    const changed: Record<string, [number, number]> = {};

    for (const param of DEVELOP_PARAMS) {
      const predicted = prediction.develop[param.key];
      if (predicted === undefined) continue;
      // A slider absent from the edit sits at its neutral default, which for the
      // curve knots is the identity and for everything else is zero.
      const current = actual[param.key] ?? (CURVE_KEYS.has(param.key) ? (param.refConst ?? 0) : 0);
      if (!Number.isFinite(current)) continue;

      let s = stats.get(param.key);
      if (!s) {
        s = { compared: 0, kept: 0, engaged: 0, engagedKept: 0, signed: 0, absolute: 0, err: 0, fromNeutral: 0 };
        stats.set(param.key, s);
      }
      s.compared++;
      // Did either side actually move this slider off its neutral? Agreeing to
      // leave it alone is not a prediction — see ParamFeedback.engaged.
      const neutral = CURVE_KEYS.has(param.key) ? (param.refConst ?? 0) : 0;
      const tol = tolerance(param.key);
      const engaged = Math.abs(predicted - neutral) > tol || Math.abs(current - neutral) > tol;
      if (engaged) {
        s.engaged++;
        s.err += Math.abs(current - predicted);
        s.fromNeutral += Math.abs(current - neutral);
      }
      const delta = current - predicted;
      if (Math.abs(delta) <= tol) {
        s.kept++;
        if (engaged) s.engagedKept++;
      } else {
        changed[param.key] = [predicted, current];
        s.signed += delta;
        s.absolute += Math.abs(delta);
      }
    }
    if (Object.keys(changed).length === 0) untouchedImages++;
    if (args.out) pairs.push({ file: prediction.file, treatment: prediction.treatment, changed });
  }

  const compared = predictions.length - missing;
  if (compared === 0) {
    logError('none of the predicted files carry develop settings today — nothing to compare against');
    process.exitCode = 2;
    return;
  }

  const rows: ParamFeedback[] = DEVELOP_PARAMS.flatMap((param) => {
    const s = stats.get(param.key);
    if (!s || s.compared === 0) return [];
    const corrected = s.compared - s.kept;
    return [{
      key: param.key,
      group: param.group,
      compared: s.compared,
      kept: s.kept,
      engaged: s.engaged,
      engagedKept: s.engagedKept,
      bias: corrected > 0 ? s.signed / corrected : 0,
      spread: corrected > 0 ? s.absolute / corrected : 0,
      journey: s.fromNeutral > 1e-9 ? 1 - s.err / s.fromNeutral : 0,
    }];
  });

  const totalCompared = rows.reduce((a, r) => a + r.compared, 0);
  const totalKept = rows.reduce((a, r) => a + r.kept, 0);
  const totalEngaged = rows.reduce((a, r) => a + r.engaged, 0);
  const totalEngagedKept = rows.reduce((a, r) => a + r.engagedKept, 0);
  const acceptance = totalCompared > 0 ? totalKept / totalCompared : 0;
  const engagedAcceptance = totalEngaged > 0 ? totalEngagedKept / totalEngaged : 0;

  if (args.out) {
    await writeFile(args.out, pairs.map((p) => JSON.stringify(p)).join('\n') + '\n', 'utf8');
  }

  if (io.json) {
    printJson({
      command: 'develop-feedback',
      images: { predicted: predictions.length, compared, notEditedYet: missing, untouched: untouchedImages },
      acceptance,
      engagedAcceptance,
      params: rows,
    });
    return;
  }

  const w = process.stderr;
  w.write(`\nFeedback on ${compared} of ${predictions.length} predicted images\n`);
  if (missing > 0) w.write(`  ${missing} carry no develop settings yet — not compared\n`);
  w.write(`  ${untouchedImages} accepted with no change at all\n\n`);
  w.write(`  kept ${(engagedAcceptance * 100).toFixed(1)}% of the parameters either of us moved\n`);
  w.write(`       (${(acceptance * 100).toFixed(1)}% counting the sliders we both left at neutral —\n`);
  w.write(`        that number flatters the model and is not the one to quote)\n\n`);

  // Most-corrected first: that is the list worth acting on. Only parameters
  // somebody actually engaged with; the rest have nothing to report.
  // Enough comparisons to mean something, worst journey first: that is the list
  // worth acting on.
  const worst = rows
    .filter((r) => r.engaged >= 20)
    .sort((a, b) => a.journey - b.journey);
  w.write('  param                           moved   kept   journey   corrected by   offset\n');
  for (const r of worst.slice(0, 25)) {
    const keptPct = `${((r.engagedKept / r.engaged) * 100).toFixed(0)}%`;
    const sign = r.bias >= 0 ? '+' : '';
    w.write(
      `  ${r.key.padEnd(30)} ${String(r.engaged).padStart(5)} ${keptPct.padStart(6)} ` +
        `${(r.journey * 100).toFixed(0).padStart(8)}% ${r.spread.toFixed(2).padStart(14)} ` +
        `${(sign + r.bias.toFixed(2)).padStart(8)}\n`,
    );
  }
  const skipped = rows.filter((r) => r.engaged > 0 && r.engaged < 20).length;
  if (worst.length > 25) w.write(`  … ${worst.length - 25} more (pass --json for all)\n`);
  if (skipped > 0) w.write(`  (${skipped} parameters moved on fewer than 20 images — too few to read)\n`);

  w.write('\n  "kept" is the real product metric — held-out skill is only its proxy.\n');
  w.write('  "journey" is how much of the move the prediction already made for you;\n');
  w.write('  negative means it landed further off than leaving the slider alone.\n');
  w.write('  A large offset with a small spread is not a modelling failure: it is a\n');
  w.write('  constant this profile is missing, and a constant is easy to fix.\n');
  w.write('\n  This compares a prediction against what the file says today. If a sidecar\n');
  w.write('  was never imported and the photograph was edited from scratch, the gap is\n');
  w.write('  two independent opinions rather than our error — the tool cannot tell.\n');
  if (args.out) printHuman(io, `\nWrote the corrected pairs to ${args.out}`);
}
