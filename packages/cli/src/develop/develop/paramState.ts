/**
 * What a parameter does at prediction time, and why.
 *
 * The profile already carried the raw facts — which head is gated, whether the
 * target was degenerate — and every reader reconstructed the same three
 * conclusions from them, differently. These functions are that reconstruction,
 * done once: a prediction is `predicted`, `leveled` or `constant`, and a
 * constant states which of three reasons put it there.
 *
 * Abstention is a first-class answer here, not a failure to predict. A slider
 * the evidence cannot support is left at the photographer's own value, and the
 * profile says so rather than emitting a number that looks like a decision.
 */
import type { GateReason, ParamState } from '../types.js';

/** The three states, in the order a report should list them. */
export const PARAM_STATES: readonly ParamState[] = ['predicted', 'leveled', 'constant'];

/** What a head has to look like for the state to be read off it. */
export interface HeadOutcome {
  gated: boolean;
  /** De-shrinking slope actually applied — 0 means the head cannot move. */
  response: number;
}

/**
 * Does this head emit its own constant, whatever the gate flag says?
 *
 * Two different things produce the same output. The gate is the explicit one.
 * The other is a de-shrinking slope of zero, which `clampResponse` produces when
 * the measured slope came out at or below zero — held-out anti-correlation, the
 * fit reading noise. Inference multiplies the departure from the mean by that
 * slope (`predict.ts`), so a response of 0 returns the mean exactly as a gate
 * does. Reading only `gated` reports such a parameter as predicted when it
 * provably cannot move.
 */
export function headEmitsConstant(head: HeadOutcome): boolean {
  return head.gated || head.response === 0;
}

/**
 * State from what the two heads actually emit.
 *
 * `leveled` is the honest name for the case a photographer notices first: the
 * model knows where the shoot sits but cannot tell two of its frames apart, so
 * every frame comes back with the same value. Calling that `predicted` would be
 * a claim the model does not support.
 */
export function paramState(level: HeadOutcome, frame: HeadOutcome): ParamState {
  const levelFlat = headEmitsConstant(level);
  const frameFlat = headEmitsConstant(frame);
  if (levelFlat && frameFlat) return 'constant';
  return frameFlat ? 'leveled' : 'predicted';
}

/**
 * Why a constant is a constant.
 *
 * Order matters: a degenerate target — one the photographer never moved — is
 * the reason even when the skill also came out negative, because there was
 * nothing to predict in the first place and "worse than the average" is a
 * meaningless thing to say about a column that never varies.
 */
export function gateReasonFor(degenerate: boolean, negativeSkill: boolean): GateReason {
  if (degenerate) return 'degenerate';
  return negativeSkill ? 'negative-skill' : 'low-skill';
}

/** One line a reader can act on, per gate reason. */
export function describeGateReason(reason: GateReason): string {
  switch (reason) {
    case 'degenerate':
      return 'you never varied it — there is nothing to predict';
    case 'negative-skill':
      return 'predicting it was measurably worse than your own average';
    default:
      return 'its skill was not clear of its own measurement noise';
  }
}

/**
 * Parameter → state, for one branch.
 *
 * An anchored slider is reported as `predicted` whatever its heads did: the
 * anchor replaces both of them, so the heads' gates describe machinery that does
 * not run for it. Reading a profile without this correction is how `Dehaze` — a
 * slider that ships at 0.258 tail skill — comes back labelled a constant.
 *
 * A profile written before the state was recorded has none, so the state is
 * reconstructed from the gates it does carry.
 */
export function stateMap(branch: {
  perParam: readonly { key: string; state?: ParamState; level: HeadOutcome; frame: HeadOutcome }[];
  anchors?: Record<string, unknown>;
}): Record<string, ParamState> {
  const out: Record<string, ParamState> = {};
  for (const p of branch.perParam) {
    out[p.key] = branch.anchors?.[p.key] ? 'predicted' : (p.state ?? paramState(p.level, p.frame));
  }
  return out;
}

/**
 * How many parameters sit in each state.
 *
 * Takes the output of {@link stateMap} rather than the raw rows, so the anchor
 * correction is applied once and every caller counts the same thing.
 */
export function countStates(states: Record<string, ParamState>): Record<ParamState, number> {
  const counts: Record<ParamState, number> = { predicted: 0, leveled: 0, constant: 0 };
  for (const state of Object.values(states)) counts[state]++;
  return counts;
}

/** One line saying what the profile will and will not move. */
export function summariseStates(counts: Record<ParamState, number>, negativeSkill = 0): string {
  const total = counts.predicted + counts.leveled + counts.constant;
  return (
    `${counts.predicted}/${total} sliders follow the photograph, ` +
    `${counts.leveled} take one value per shoot, ` +
    `${counts.constant} stay at your own constant` +
    (negativeSkill > 0 ? ` (${negativeSkill} of them because predicting them was worse than your average)` : '')
  );
}
