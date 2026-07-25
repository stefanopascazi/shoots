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
import type { RatingProfile } from './profiles.js';

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
  /**
   * The L2-normalized CLIP image embedding (512-d) in the backend's embedding
   * space. Populated only when explicitly requested (opt-in via `rate
   * --embeddings`), since it is bulky and only preference-learning tooling needs
   * it. The {@link QualityModel.name} identifies the embedding space, so a
   * consumer can guard that a learned profile matches.
   */
  embedding?: number[];
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
 * Map an assessment to a 0–5 star rating under a {@link RatingProfile}.
 *
 * Focus never adds stars — for a competent shooter it is ~constant near the top,
 * so it only ever gates (reject below `focusReject`, cap soft frames at
 * `focusSoftCap`). Stars are driven by the aesthetic merit, which the profile
 * has already aggregated from the aspects it cares about, against the profile's
 * cut-offs. Different profiles = different "what matters" and "how strict".
 */
export function toStarRating(assessment: QualityAssessment, profile: RatingProfile): StarRating {
  if (assessment.focus < profile.focusReject) return 0;

  let stars: StarRating = 0;
  for (const t of profile.aestheticStars) {
    if (assessment.aesthetic >= t.min) {
      stars = t.stars;
      break;
    }
  }
  if (assessment.focus < profile.focusSoft && stars > profile.focusSoftCap) {
    stars = profile.focusSoftCap;
  }
  return stars;
}
