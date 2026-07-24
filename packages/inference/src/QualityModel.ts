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
 * Focus below this means no region is truly in focus (soft / missed focus).
 * Such frames are capped low no matter how pleasant their exposure/colour.
 */
const FOCUS_SOFT = 0.5;
/** Star cut-offs on the combined score. Deliberately demanding (see below). */
const STAR_THRESHOLDS: readonly { min: number; stars: StarRating }[] = [
  { min: 0.86, stars: 5 },
  { min: 0.72, stars: 4 },
  { min: 0.56, stars: 3 },
  { min: 0.4, stars: 2 },
  { min: 0.24, stars: 1 },
];

/**
 * Map an assessment to a strict 0–5 star rating.
 *
 * Philosophy (per product direction): be *unforgiving*. A meaningless 1-star is
 * worse than an honest 0, so technically failed frames score 0, most frames land
 * at 2–3, and 5 is reserved for images that are both technically clean and
 * strong across the aesthetic aspects. Focus gates the ceiling — a soft frame
 * cannot be a keeper regardless of how nice its light and colour are.
 */
export function toStarRating(assessment: QualityAssessment): StarRating {
  if (assessment.focus < FOCUS_REJECT) return 0;

  const combined = 0.5 * assessment.focus + 0.5 * assessment.aesthetic;
  const ceiling: StarRating = assessment.focus < FOCUS_SOFT ? 2 : 5;

  let stars: StarRating = 0;
  for (const t of STAR_THRESHOLDS) {
    if (combined >= t.min) {
      stars = t.stars;
      break;
    }
  }
  return (stars < ceiling ? stars : ceiling) as StarRating;
}
