/**
 * Shared types for the develop tool.
 *
 * It never touches CLIP/onnx: it consumes the dataset emitted by
 * `shoots develop-export` (CLIP embedding + explicit color features + crs develop
 * targets + as-shot metadata + treatment/profile), fits ONE ridge model per
 * treatment (colour / B&W) over that treatment's shared+branch parameters, and
 * exports a branched per-catalog develop profile.
 */
import type { AsShotMeta, Treatment } from './develop/schema.js';

/** One image record inside a `shoots develop-export` dataset. */
export interface DevelopExportResult {
  file: string;
  embedding: number[];
  features: number[];
  /** Raw absolute crs develop values actually present (absent ⇒ ACR default). */
  develop: Record<string, number>;
  asShot: AsShotMeta;
  /** Black-and-white vs colour, read deterministically off the edit. */
  treatment?: Treatment;
  /** Base rendering profile (crs CameraProfile), e.g. "Camera Faithful v2". */
  baseProfile?: string;
  /** Flattened point tone-curve [x0,y0,x1,y1,…] (ToneCurvePV2012); absent if linear. */
  curve?: number[];
  /** Present only in the legacy per-record format; the baseline lives on the dataset. */
  baseline?: string;
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
  branch: string;
  weight: number;
  modelMae: number;
  baselineMae: number;
  skill: number;
}

/** A trained model for one treatment (colour or B&W), over shared+branch params. */
export interface BranchModel {
  treatment: Treatment;
  /** Ordered crs param keys this branch predicts (shared + branch). */
  params: string[];
  ridgeLambda: number;
  /** Per-feature standardization of the input X (length embeddingDim+colorDim+3). */
  featureMean: number[];
  featureStd: number[];
  /** Per-parameter standardization of the target DELTA (length = params.length). */
  deltaMean: number[];
  deltaStd: number[];
  /** Head weights: P rows × D cols, over the standardized feature space. */
  weights: number[][];
  bias: number[];
  samples: number;
  heldOut: number;
  imageDependentSkill: number | null;
  perParam: ParamEval[];
}

/**
 * The deliverable: one {@link BranchModel} per treatment present in the catalog,
 * plus the guards (schema version + dims + embedding model) that gate
 * applicability, exactly like the linear-embedding rating profile.
 */
export interface DevelopProfile {
  name: string;
  description: string;
  type: 'develop-branched';
  schemaVersion: number;
  embeddingModel: string;
  embeddingDim: number;
  colorDim: number;
  colorFeatureNames: string[];
  baseline: string;
  branches: Partial<Record<Treatment, BranchModel>>;
  trainedAt: string;
  stats: {
    edited: number;
    color: number;
    bw: number;
  };
}
