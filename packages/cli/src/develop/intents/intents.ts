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
 */
import { meetConstraints, constrained, type LookConstraint, type ToneControl } from '../look/solve.js';
import { LOOK_PERCENTILES, lookOf, TONE_KEYS, toneFromDevelop, toneToDevelop, type LumaHistogram } from '../look/tone.js';

const at = (p: number): number => LOOK_PERCENTILES.indexOf(p as (typeof LOOK_PERCENTILES)[number]);

export interface IntentDef {
  id: string;
  label: string;
  /** The sliders a photographer reaches for to do this — the only ones it may move. */
  controls: ToneControl[];
  /** Bounds given the look the prediction produces on this frame. */
  constraints(look: readonly number[]): LookConstraint[];
}

/** Display-value bounds, 0..1. Chosen numbers, to be judged by eye on real shoots. */
const HIGHLIGHT_CAP = 0.93;
const SHADOW_FLOOR = 0.1;
const DEEP_SHADOW_CAP = 0.045;
const MID_LOW = 0.38;
const MID_HIGH = 0.55;
const CONTRAST_STEP = 0.15;

export const INTENTS: readonly IntentDef[] = [
  {
    id: 'expose-correctly',
    label: 'Expose correctly',
    controls: ['exposure'],
    // A band, not a target: a frame whose midtones sit anywhere reasonable is left alone.
    constraints: () => [{ at: at(0.5), min: MID_LOW, max: MID_HIGH }],
  },
  {
    id: 'preserve-highlights',
    label: 'Preserve highlights',
    controls: ['highlights', 'whites'],
    constraints: (look) => [{ at: at(0.99), max: Math.min(look[at(0.99)]!, HIGHLIGHT_CAP) }],
  },
  {
    id: 'open-shadows',
    label: 'Open shadows',
    controls: ['shadows', 'blacks'],
    constraints: (look) => [{ at: at(0.05), min: Math.max(look[at(0.05)]!, SHADOW_FLOOR) }],
  },
  {
    id: 'keep-shadows-deep',
    label: 'Keep shadows deep',
    controls: ['shadows', 'blacks'],
    constraints: (look) => [{ at: at(0.05), max: Math.min(look[at(0.05)]!, DEEP_SHADOW_CAP) }],
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
 */
export function applyIntents(
  develop: Record<string, number>,
  hist: LumaHistogram,
  intents: readonly IntentDef[],
): Record<string, number> {
  if (!intents.length) return develop;
  const prior = toneFromDevelop(develop);
  const look = lookOf(hist, prior);
  const constraints = intents.flatMap((i) => i.constraints(look));
  const free = [...new Set(intents.flatMap((i) => i.controls))];
  const solved = meetConstraints(hist, constraints, prior, free);
  if (solved === prior) return develop;
  const tone = toneToDevelop(solved);
  const before = toneToDevelop(prior);
  const out = { ...develop };
  // Only what the solver moved is written, rounded to the editor's own steps
  // (hundredths of EV, whole slider units); the rest keeps the prediction's value.
  for (const k of TONE_KEYS) {
    if (tone[k] === before[k]) continue;
    out[k] = k === 'Exposure2012' ? Math.round(tone[k] * 100) / 100 : Math.round(tone[k]);
  }
  return out;
}
