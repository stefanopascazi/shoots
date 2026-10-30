/**
 * Global develop intents: what the photographer asks of a shoot before applying.
 *
 * An intent is a bound on the *look* — where the histogram lands on screen —
 * not a slider value, and it is read relative to the prediction it corrects:
 * "preserve highlights" caps the brightest percentile at whichever is lower, the
 * cap or where the prediction already put it. So an intent the prediction
 * already satisfies changes nothing, and one it violates moves only as far as
 * the bound needs. The tone solver (look/solve.ts) finds the sliders.
 *
 * Applied last, after the general profile and any style: an intent is an
 * explicit instruction and outranks what was learned.
 *
 * Region intents (save the sky, lift the subject) bound the look of one region,
 * found by the vision model, but still move global sliders: Lightroom's plug-in
 * SDK cannot create masks, so "save the sky" is the global Highlights/Whites
 * that keep the sky's pixels under the cap. A frame without that region is left
 * alone by that intent.
 */
import { meetConstraints, constrained, type LookConstraint, type ToneControl } from '../look/solve.js';
import { LOOK_PERCENTILES, lookOf, TONE_KEYS, toneFromDevelop, toneToDevelop, type LumaHistogram } from '../look/tone.js';
import { DEFAULT_THRESHOLDS, type IntentThresholds } from './calibrate.js';
import type { VisionRegion } from '../../vision/record.js';

const at = (p: number): number => LOOK_PERCENTILES.indexOf(p as (typeof LOOK_PERCENTILES)[number]);

export interface IntentDef {
  id: string;
  label: string;
  /** The sliders a photographer reaches for to do this — the only ones it may move. */
  controls: ToneControl[];
  /** Regions this intent reads; the vision model is consulted only when one is asked for. */
  regions?: VisionRegion[];
  /**
   * Bounds given the look the prediction produces on this frame (and on each
   * region present in it), in the photographer's thresholds.
   */
  constraints(look: readonly number[], t: IntentThresholds, regions: Partial<Record<VisionRegion, readonly number[]>>): LookConstraint[];
}

/** How much softer or punchier the contrast intents make the 10–90 spread. */
const CONTRAST_STEP = 0.1;

export const INTENTS: readonly IntentDef[] = [
  {
    id: 'expose-correctly',
    label: 'Expose correctly',
    controls: ['exposure'],
    // A band, not a target: a frame whose midtones sit anywhere reasonable is left alone.
    constraints: (_, t) => [{ at: at(0.5), min: t.midLow, max: t.midHigh }],
  },
  {
    id: 'preserve-highlights',
    label: 'Preserve highlights',
    controls: ['highlights', 'whites'],
    constraints: (look, t) => [{ at: at(0.99), max: Math.min(look[at(0.99)]!, t.highlightCap) }],
  },
  {
    id: 'open-shadows',
    label: 'Open shadows',
    controls: ['shadows', 'blacks'],
    constraints: (look, t) => [{ at: at(0.05), min: Math.max(look[at(0.05)]!, t.shadowFloor) }],
  },
  {
    id: 'keep-shadows-deep',
    label: 'Keep shadows deep',
    controls: ['shadows', 'blacks'],
    constraints: (look, t) => [{ at: at(0.05), max: Math.min(look[at(0.05)]!, t.deepShadowCap) }],
  },
  {
    id: 'soft-contrast',
    label: 'Soft contrast',
    controls: ['contrast'],
    constraints: (look) => [{ at: 'spread', max: constrained(look, 'spread') * (1 - CONTRAST_STEP) }],
  },
  {
    id: 'punchy-contrast',
    label: 'Punchy contrast',
    controls: ['contrast'],
    constraints: (look) => [{ at: 'spread', min: constrained(look, 'spread') * (1 + CONTRAST_STEP) }],
  },
  {
    id: 'save-the-sky',
    label: 'Save the sky',
    controls: ['highlights', 'whites'],
    regions: ['sky'],
    // The sky's bright end under the photographer's typical highlights: detail kept in the clouds.
    constraints: (_, t, r) => (r.sky ? [{ region: 'sky', at: at(0.95), max: Math.min(r.sky[at(0.95)]!, t.highlightCap) }] : []),
  },
  {
    id: 'lift-the-subject',
    label: 'Lift the subject',
    controls: ['shadows', 'exposure'],
    regions: ['subject'],
    // The subject's midtones no darker than the low edge of the photographer's
    // exposure band. The band's middle was tried first and asked +1.3 EV of
    // ordinary indoor portraits.
    constraints: (_, t, r) => (r.subject ? [{ region: 'subject', at: at(0.5), min: Math.max(r.subject[at(0.5)]!, t.midLow) }] : []),
  },
];

/** Pairs that ask for opposite things; asking for both is a mistake, not a compromise. */
const CONFLICTS: readonly [string, string][] = [
  ['open-shadows', 'keep-shadows-deep'],
  ['soft-contrast', 'punchy-contrast'],
];

export const INTENT_IDS = INTENTS.map((i) => i.id);

/** Validated, de-duplicated intent definitions; throws on unknown ids or conflicting pairs. */
export function resolveIntents(ids: readonly string[]): IntentDef[] {
  const unique = [...new Set(ids.map((i) => i.trim().toLowerCase()).filter(Boolean))];
  const unknown = unique.filter((i) => !INTENT_IDS.includes(i));
  if (unknown.length) throw new Error(`unknown intent(s): ${unknown.join(', ')} (available: ${INTENT_IDS.join(', ')})`);
  for (const [a, b] of CONFLICTS) {
    if (unique.includes(a) && unique.includes(b)) throw new Error(`intents '${a}' and '${b}' ask for opposite things — pick one`);
  }
  return INTENTS.filter((i) => unique.includes(i.id));
}

/**
 * One frame's predicted develop values with the intents met.
 *
 * Only the six tone controls the solver models move; everything else — colour,
 * curve, white balance — is the prediction's. Returns the input object when no
 * intent asked for a change.
 *
 * `strength` scales the solver's move: 1 meets the bounds, 0.5 goes halfway,
 * 0 leaves the prediction alone. It is the dial for tuning intents by eye in the
 * editor, where the thresholds alone cannot be judged.
 */
export function applyIntents(
  develop: Record<string, number>,
  hist: LumaHistogram,
  intents: readonly IntentDef[],
  thresholds: IntentThresholds = DEFAULT_THRESHOLDS,
  strength = 1,
  regions: Partial<Record<VisionRegion, LumaHistogram>> = {},
): Record<string, number> {
  if (!intents.length || strength <= 0) return develop;
  const prior = toneFromDevelop(develop);
  const look = lookOf(hist, prior);
  const regionLooks = Object.fromEntries(Object.entries(regions).map(([k, h]) => [k, lookOf(h!, prior)]));
  const constraints = intents.flatMap((i) => i.constraints(look, thresholds, regionLooks));
  if (!constraints.length) return develop;
  const free = [...new Set(intents.flatMap((i) => i.controls))];
  const solved = meetConstraints(hist, constraints, prior, free, undefined, regions as Record<string, LumaHistogram>);
  if (solved === prior) return develop;
  const before = toneToDevelop(prior);
  const full = toneToDevelop(solved);
  const tone = Object.fromEntries(TONE_KEYS.map((k) => [k, before[k] + strength * (full[k] - before[k])])) as typeof full;
  const out = { ...develop };
  // Only what the solver moved is written, rounded to the editor's own steps
  // (hundredths of EV, whole slider units); the rest keeps the prediction's value.
  for (const k of TONE_KEYS) {
    // Below half an editor step the solver only jittered; writing it would round the prediction.
    if (Math.abs(tone[k] - before[k]) < (k === 'Exposure2012' ? 0.005 : 0.5)) continue;
    out[k] = k === 'Exposure2012' ? Math.round(tone[k] * 100) / 100 : Math.round(tone[k]);
  }
  return out;
}
