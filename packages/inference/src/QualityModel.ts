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

export interface QualityAssessment {
  /** Focus/sharpness confidence in [0, 1]. */
  focus: number;
  /** Aesthetic score in [0, 1]. */
  aesthetic: number;
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

  /** Convenience: all three in one call (backends may batch internally). */
  assess(image: ImageInput): Promise<QualityAssessment>;

  /** Release runtime resources (ONNX sessions, GPU memory, ...). */
  dispose(): Promise<void>;
}

export type StarRating = 1 | 2 | 3 | 4 | 5;

/**
 * Map an assessment to a 1–5 star rating.
 * Focus dominates: a technically missed shot can't be a keeper.
 */
export function toStarRating(assessment: QualityAssessment): StarRating {
  const combined = 0.6 * assessment.focus + 0.4 * assessment.aesthetic;
  const stars = 1 + Math.round(combined * 4);
  return Math.min(5, Math.max(1, stars)) as StarRating;
}
