/**
 * Shared types for the develop tool.
 *
 * It never touches CLIP/onnx: it consumes the dataset emitted by
 * `shoots develop-export` (CLIP embedding + explicit color features + crs
 * develop targets + as-shot metadata), fits a multi-output ridge over the
 * develop-setting deltas, and exports a per-catalog develop profile.
 */
import type { AsShotMeta } from './develop/schema.js';

/** One image record inside a `shoots develop-export` dataset. */
export interface DevelopExportResult {
  file: string;
  embedding: number[];
  features: number[];
  /** Raw absolute crs develop values actually present (absent ⇒ ACR default). */
  develop: Record<string, number>;
  asShot: AsShotMeta;
  baseline: string;
}

/** The whole `shoots develop-export` payload. */
export interface DevelopDataset {
  command: 'develop-export';
  model: string;
  dim: number;
  colorFeatureNames: string[];
  colorDim: number;
  baseline: string;
  results: DevelopExportResult[];
  summary?: unknown;
}

/** Per-parameter held-out evaluation — the go/no-go evidence. */
export interface ParamEval {
  key: string;
  group: string;
  weight: number;
  /** Held-out mean-absolute-error in the parameter's native ACR units. */
  modelMae: number;
  /** MAE of the naive "apply my average edit" baseline (photographer mean). */
  baselineMae: number;
  /** Skill score 1 − modelMae/baselineMae; >0 means the model beats the mean. */
  skill: number;
}

/**
 * The deliverable: everything needed to turn a new image's (embedding, color
 * features, as-shot metadata) into a full develop-setting vector. Standardization
 * stats are stored so inference can invert them; the schema version + dims guard
 * applicability, exactly like the linear-embedding rating profile guards its
 * embedding space.
 */
export interface DevelopProfile {
  name: string;
  description: string;
  type: 'develop-linear';
  schemaVersion: number;
  /** Must match the scoring backend's model name to be applicable. */
  embeddingModel: string;
  /** CLIP embedding dim. */
  embeddingDim: number;
  /** Explicit color-feature dim (and their names, for interpretability). */
  colorDim: number;
  colorFeatureNames: string[];
  baseline: string;
  ridgeLambda: number;
  /** Ordered crs param keys this profile predicts (mirrors the schema order). */
  params: string[];
  /** Per-feature standardization of the input X (length embeddingDim+colorDim). */
  featureMean: number[];
  featureStd: number[];
  /** Per-parameter standardization of the target DELTA (length = params.length). */
  deltaMean: number[];
  deltaStd: number[];
  /** Head weights: P rows × D cols, over the standardized feature space. */
  weights: number[][];
  bias: number[];
  trainedAt: string;
  stats: {
    samples: number;
    withDevelop: number;
    heldOut: number;
    /** Weighted-mean skill over image-dependent params — the headline GATE number. */
    imageDependentSkill: number | null;
    perParam: ParamEval[];
  };
}
