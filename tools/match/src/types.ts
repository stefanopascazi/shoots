/**
 * Shared types for the match tool.
 *
 * The tool never touches CLIP/onnx: it consumes the consolidated dataset emitted
 * by `shoots embeddings` (raw CLIP embeddings + neutral aspects), stores it in
 * SQLite, collects pairwise preferences, and trains a linear-embedding profile.
 */

/** One image record inside a `shoots embeddings --json` dataset. */
export interface DatasetResult {
  file: string;
  embedding: number[];
  aspects: { name: string; score: number }[];
  keywords: string[];
  focus: number;
  /** Neutral aesthetic seed (unweighted mean of aspects); may be null. */
  aestheticSeed: number | null;
}

/** The whole `shoots embeddings --json` payload. */
export interface Dataset {
  command: 'embeddings';
  model: string;
  dim: number;
  results: DatasetResult[];
  summary?: unknown;
}

/** A photo row as stored / read back. */
export interface PhotoRow {
  id: number;
  path: string;
  model: string;
  embedding: Float32Array;
  clip_score: number | null;
  aspects: string | null;
  created_at: string;
}

/** A pairwise outcome: `winner` was kept over `loser`. */
export interface Comparison {
  winner_id: number;
  loser_id: number;
}

/**
 * The deliverable. Field names mirror @shoots/inference `RatingProfile`
 * (flat focus gate, `aestheticStars`) plus the `linear-embedding` branch, so a
 * future Shoots loader only has to switch on `type`.
 */
export interface LinearEmbeddingProfile {
  name: string;
  description: string;
  type: 'linear-embedding';
  calibrated: true;
  /** Must match the scoring backend's model name to be applicable. */
  embeddingModel: string;
  dim: number;
  weights: number[];
  bias: number;
  /** Maps the raw w·x score into a stable [0,1] via a logistic on (s-mean)/std. */
  scoreNormalization: { mean: number; std: number };
  focusReject: number;
  focusSoft: number;
  focusSoftCap: number;
  /** Cut-offs on the NORMALIZED [0,1] score, descending. */
  aestheticStars: { min: number; stars: number }[];
  trainedAt: string;
  stats: { duels: number; photos: number; heldOutPairAccuracy: number | null };
}
