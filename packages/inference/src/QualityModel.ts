/**
 * Abstract interface for ML-based image quality scoring.
 *
 * Design constraints (the whole point of this package):
 * - Callers (`shoots rate`, future pipeline steps, a future REST layer) depend
 *   ONLY on this interface. Swapping the stub for an onnxruntime-node backend
 *   — or a cloud inference endpoint — must require zero changes outside
 *   `@shoots/inference`.
 * - Inputs are passed by path with an optional pre-loaded buffer, so backends
 *   can choose their own decode strategy (e.g. the ONNX backend will want to
 *   preprocess to a fixed tensor size itself).
 */

export interface ImageInput {
  /** Absolute path to the image file (RAW or processed). */
  path: string;
  /**
   * Optional pre-decoded pixels (e.g. an embedded RAW preview already
   * extracted by the caller). Backends may use or ignore it.
   */
  buffer?: Buffer;
}

/** Per-dimension aesthetic breakdown (composition, exposure, subject, ...). */
export interface AestheticAspectScore {
  /** Aspect identifier, e.g. 'composition', 'exposure', 'subject'. */
  name: string;
  /** This aspect's score in [0, 1]. */
  score: number;
}

export interface QualityAssessment {
  /** Focus/sharpness confidence in [0, 1]. */
  focus: number;
  /** Aesthetic score in [0, 1] (overall, aggregated from {@link aspects}). */
  aesthetic: number;
  /**
   * Per-dimension aesthetic breakdown when the backend provides one (CLIP
   * zero-shot). Empty when only the technical heuristic fallback ran.
   */
  aspects: AestheticAspectScore[];
  /** Suggested keywords, most relevant first. */
  keywords: string[];
}

export interface QualityModel {
  /** Backend identifier, recorded in sidecars for provenance. */
  readonly name: string;

  /** Load weights / warm up the runtime. Must be called before scoring. */
  init(): Promise<void>;

  /** Focus/sharpness confidence in [0, 1]. */
  scoreFocus(image: ImageInput): Promise<number>;

  /** Aesthetic score in [0, 1]. */
  scoreAesthetic(image: ImageInput): Promise<number>;

  /** Suggested keywords, most relevant first. */
  suggestKeywords(image: ImageInput): Promise<string[]>;

  /** Convenience: all signals in one call (backends may batch internally). */
  assess(image: ImageInput): Promise<QualityAssessment>;

  /** Release runtime resources (ONNX sessions, GPU memory, ...). */
  dispose(): Promise<void>;
}

/** 0 = reject (unusable), 5 = flawless keeper. 0 is a first-class verdict. */
export type StarRating = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * Focus below this is a technical reject: nothing worth keeping is in focus.
 * At the ONNX backend's focus normalization this is ~1/3 of the cull
 * focus-threshold — a frame no region is sharp in.
 */
const FOCUS_REJECT = 0.3;
/**
 * Focus below this means no region is truly in focus (soft / missed focus). To a
 * professional eye such a frame is not a keeper, so it is capped at 1 star no
 * matter how strong its content.
 */
const FOCUS_SOFT = 0.55;

/**
 * Demanding absolute cut-offs on the *aesthetic* score (0..1). Focus does not
 * add stars here — for a competent shooter it is ~constant and near the top on
 * essentially every frame, so it only ever gates (reject / soft-cap). What earns
 * stars is the aesthetic signal, judged against a professional bar:
 *   0 = the default (competent but ordinary — fine for an amateur, not a pro)
 *   1–2 = decent, not yet good
 *   3 = a genuinely good shot (already uncommon)
 *   4 = exhibition-grade (rare)
 *   5 = an image that carries a story on its own, beyond time and viewer (almost never)
 *
 * The aesthetic is zero-shot CLIP, whose scores sit in a compressed band, so the
 * upper cut-offs are close together and 5 is effectively unreachable without a
 * stronger aesthetic model — an intentional, honest ceiling. Calibrated against
 * real professional shoots to put the mass of frames at 0.
 */
const AESTHETIC_STARS: readonly { min: number; stars: StarRating }[] = [
  { min: 0.65, stars: 5 },
  { min: 0.61, stars: 4 },
  { min: 0.57, stars: 3 },
  { min: 0.53, stars: 2 },
  { min: 0.48, stars: 1 },
];

/**
 * Map an assessment to a strict, professional-grade 0–5 star rating. Be
 * *unforgiving*: most frames are an honest 0, and 3+ is reserved for images that
 * genuinely stand out. See {@link AESTHETIC_STARS}.
 */
export function toStarRating(assessment: QualityAssessment): StarRating {
  if (assessment.focus < FOCUS_REJECT) return 0;

  let stars: StarRating = 0;
  for (const t of AESTHETIC_STARS) {
    if (assessment.aesthetic >= t.min) {
      stars = t.stars;
      break;
    }
  }
  // Soft / missed-focus frames are not professional keepers: cap at 1 star.
  if (assessment.focus < FOCUS_SOFT && stars > 1) stars = 1;
  return stars;
}
