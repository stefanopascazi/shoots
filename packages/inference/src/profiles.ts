/**
 * Rating profiles — how a given kind of photographer wants frames judged.
 *
 * A rating is not universal: a street photographer, a wedding shooter and a
 * wildlife photographer value different things, and set the keeper bar at very
 * different heights. A profile captures both axes explicitly:
 *   - WHAT matters  → `meritWeights`: how the per-aspect CLIP scores combine into
 *                     the aesthetic merit. Aspects absent from the map count 0.
 *   - HOW strict    → `aestheticStars` cut-offs + the focus gate, i.e. where the
 *                     0..5 boundaries sit.
 *
 * Note on skill level: for a beginner the technical aspects (exposure, sharpness,
 * composition) SHOULD earn stars — nailing them is an achievement. For a pro they
 * are table stakes, so pro profiles zero them and let content decide. That axis
 * lives here too, as different weights + thresholds.
 *
 * Only `street` is calibrated against a real, hand-judged shoot; the others are
 * reasonable starting priors, to be refined once per-user calibration/learning
 * lands (the profile shape is exactly what a learned head will emit). Some
 * genres (e.g. wedding) truly want aspects the current model lacks — emotion,
 * expression — which will come with a future model archive.
 */
import type { StarRating } from './QualityModel.js';

/** Fields shared by every profile kind — identity, focus gate, star cut-offs. */
export interface BaseProfile {
  /** Stable identifier used with `rate --profile`. */
  name: string;
  /** One-line description shown in help and errors. */
  description: string;
  /** True when calibrated against real judged data (vs a heuristic prior). */
  calibrated: boolean;
  /** Focus below this is a technical reject → 0 stars. */
  focusReject: number;
  /** Focus below this is soft/missed focus → capped at `focusSoftCap`. */
  focusSoft: number;
  /** Star cap applied to soft (focusReject ≤ focus < focusSoft) frames. */
  focusSoftCap: StarRating;
  /** Merit cut-offs, descending; the first one the merit clears wins. */
  aestheticStars: readonly { min: number; stars: StarRating }[];
}

/**
 * Built-in kind: aesthetic merit is a weighted mean of the per-aspect CLIP
 * scores. `meritWeights` decides WHAT matters; aspects not listed count zero.
 */
export interface AspectWeightsProfile extends BaseProfile {
  type: 'aspect-weights';
  meritWeights: Record<string, number>;
}

/**
 * Learned kind (emitted by tools/match): aesthetic merit is a linear head on the
 * CLIP embedding, `s(x) = w·x + b`, normalized to [0,1]. `aestheticStars` cut-offs
 * are on that normalized score. `embeddingModel` must match the scoring backend.
 */
export interface LinearEmbeddingProfile extends BaseProfile {
  type: 'linear-embedding';
  /** CLIP space this was trained on; guards against a mismatched backend. */
  embeddingModel: string;
  dim: number;
  weights: number[];
  bias: number;
  /** Standardization applied before the logistic squashing into [0,1]. */
  scoreNormalization: { mean: number; std: number };
}

export type RatingProfile = AspectWeightsProfile | LinearEmbeddingProfile;

/**
 * Street / documentary (the author's own eye, calibrated on a real shoot).
 * Content is everything; technical competence is assumed, so exposure/sharpness/
 * composition are zeroed. Unforgiving: the mass of a shoot lands at 0.
 */
const STREET: RatingProfile = {
  type: 'aspect-weights',
  name: 'street',
  description: 'Street / documentary — content over craft, unforgiving bar (calibrated)',
  calibrated: true,
  meritWeights: { storytelling: 1.5, overall: 1.2, subject: 1.0, lighting: 1.0 },
  focusReject: 0.3,
  focusSoft: 0.55,
  focusSoftCap: 1,
  aestheticStars: [
    { min: 0.63, stars: 5 },
    { min: 0.58, stars: 4 },
    { min: 0.55, stars: 3 },
    { min: 0.525, stars: 2 },
    { min: 0.5, stars: 1 },
  ],
};

/**
 * Generic / all-round, and forgiving — a sensible default for a beginner or a
 * mixed set. Technical competence counts toward the score, and the bar is lower
 * so a clean, well-made frame already earns a star or two.
 */
const GENERIC: RatingProfile = {
  type: 'aspect-weights',
  name: 'generic',
  description: 'All-round, forgiving — technical competence counts (prior)',
  calibrated: false,
  meritWeights: {
    overall: 1.2,
    subject: 1.0,
    storytelling: 1.0,
    composition: 1.0,
    lighting: 1.0,
    exposure: 0.8,
    sharpness: 0.8,
  },
  focusReject: 0.3,
  focusSoft: 0.5,
  focusSoftCap: 2,
  aestheticStars: [
    { min: 0.62, stars: 5 },
    { min: 0.56, stars: 4 },
    { min: 0.5, stars: 3 },
    { min: 0.44, stars: 2 },
    { min: 0.38, stars: 1 },
  ],
};

/**
 * Portrait — the subject and the light on it carry the frame; eyes must be sharp
 * (stricter soft gate). Composition matters mildly. Prior, uncalibrated.
 */
const PORTRAIT: RatingProfile = {
  type: 'aspect-weights',
  name: 'portrait',
  description: 'Portrait — subject & light lead, eyes must be sharp (prior)',
  calibrated: false,
  meritWeights: { subject: 1.5, lighting: 1.2, overall: 1.0, sharpness: 0.6, composition: 0.5, storytelling: 0.5 },
  focusReject: 0.35,
  focusSoft: 0.6,
  focusSoftCap: 1,
  aestheticStars: [
    { min: 0.62, stars: 5 },
    { min: 0.57, stars: 4 },
    { min: 0.53, stars: 3 },
    { min: 0.48, stars: 2 },
    { min: 0.43, stars: 1 },
  ],
};

/**
 * Wildlife — a sharp, well-isolated subject and a bit of behaviour/story. Focus
 * is gated hard (a soft animal is a miss). Prior, uncalibrated.
 */
const WILDLIFE: RatingProfile = {
  type: 'aspect-weights',
  name: 'wildlife',
  description: 'Wildlife — sharp subject & behaviour, strict focus (prior)',
  calibrated: false,
  meritWeights: { subject: 1.5, sharpness: 1.2, storytelling: 1.0, overall: 1.0, lighting: 0.8 },
  focusReject: 0.4,
  focusSoft: 0.65,
  focusSoftCap: 1,
  aestheticStars: [
    { min: 0.62, stars: 5 },
    { min: 0.57, stars: 4 },
    { min: 0.53, stars: 3 },
    { min: 0.48, stars: 2 },
    { min: 0.43, stars: 1 },
  ],
};

/**
 * Wedding — forgiving: a clean, well-exposed frame is already a usable pick, so
 * technical exposure counts and the bar is low; subject, light and emotion lift
 * it. True emotion/expression scoring awaits richer aspects in a future model.
 */
const WEDDING: RatingProfile = {
  type: 'aspect-weights',
  name: 'wedding',
  description: 'Wedding — forgiving, a clean frame already counts (prior)',
  calibrated: false,
  meritWeights: { subject: 1.2, overall: 1.2, lighting: 1.0, storytelling: 1.0, exposure: 0.8, composition: 0.6 },
  focusReject: 0.3,
  focusSoft: 0.5,
  focusSoftCap: 2,
  aestheticStars: [
    { min: 0.6, stars: 5 },
    { min: 0.55, stars: 4 },
    { min: 0.49, stars: 3 },
    { min: 0.43, stars: 2 },
    { min: 0.37, stars: 1 },
  ],
};

const PROFILES: readonly RatingProfile[] = [STREET, GENERIC, PORTRAIT, WILDLIFE, WEDDING];

/** Registry of built-in profiles, keyed by name. */
export const BUILTIN_PROFILES: ReadonlyMap<string, RatingProfile> = new Map(PROFILES.map((p) => [p.name, p]));

/** Default profile when none is requested. */
export const DEFAULT_PROFILE_NAME = STREET.name;

/** All built-in profile names, in presentation order. */
export const PROFILE_NAMES: readonly string[] = PROFILES.map((p) => p.name);

/** Resolve a profile by name, or undefined if unknown. */
export function getProfile(name: string): RatingProfile | undefined {
  return BUILTIN_PROFILES.get(name);
}
