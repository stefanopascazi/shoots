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
  /** Creative profile layered over it (crs Look name), e.g. "Adobe Color". */
  look?: string;
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
  /**
   * Look name → the editor's own serialization of it, once per distinct Look
   * rather than once per photograph. A Look is a catalog-level object and its
   * element runs to a couple of kilobytes; copying it onto every record would
   * put tens of megabytes of identical text into a 20k-image dataset.
   */
  looks?: Record<string, string>;
  results: DevelopExportResult[];
  summary?: unknown;
}

/** Per-parameter held-out evaluation — the go/no-go evidence. */
export interface ParamEval {
  key: string;
  group: string;
  branch: string;
  weight: number;
  /** Ridge strength this parameter is fitted with (chosen by held-out skill). */
  lambda: number;
  /** Held-out MAE with whole capture sessions kept out of training — the gate. */
  modelMae: number;
  /** Same policy, for "apply my average edit" (the mean target delta). */
  baselineMae: number;
  skill: number;
  /**
   * Skill with folds drawn at random instead of by session. Near-duplicate
   * frames from one shoot then sit on both sides of the split, so this measures
   * "finish a shoot already under way" — a real scenario, but not the one the
   * gate asks about. The gap against {@link skill} is the leakage meter.
   */
  skillRandom: number;
  /** The target never moves across the catalog: nothing to predict, and a
   *  perfect score on it would be an artefact. Excluded from the headline. */
  degenerate: boolean;
  /** Prediction suppressed in favour of the photographer's constant. */
  gated: boolean;
  gateReason?: 'low-skill' | 'degenerate';
}

/** A trained model for one treatment (colour or B&W), over shared+branch params. */
export interface BranchModel {
  treatment: Treatment;
  /** Ordered crs param keys this branch predicts (shared + branch). */
  params: string[];
  /** Base-rendering vocabulary (camera profile + Look) one-hot-appended to the features. */
  renderVocab: string[];
  /**
   * How many embedding features this branch consumes: 0 when the embedding is
   * dropped, the PCA rank when it is projected, the full dim when it is raw.
   */
  embeddingFeatures: number;
  /**
   * Width of the session-context block, 0 when this branch had too few images to
   * afford describing the whole shoot. Inference must match it exactly.
   */
  sessionFeatures: number;
  /** The fitted projection, present only when the embedding is compressed. */
  embeddingPca?: { mean: number[]; components: number[][] };
  /**
   * The rendering to assume, and to write out, when the image being predicted
   * does not state one — which is every unedited file, i.e. the whole point of
   * the tool. It is the branch's most common rendering, because that is the one
   * most of the learned deltas were measured against.
   */
  defaultRender: { profile?: string; look?: string };
  /**
   * Look name → the editor's own serialization, for every Look this branch can
   * emit. Carried in the profile because a Look cannot be reconstructed from its
   * name: it is resolved by UUID and look-table digest, and inventing a
   * plausible-looking element is a guess that fails inside someone's catalog.
   */
  looks: Record<string, string>;
  /**
   * Ridge strength per parameter, index-aligned with {@link params}.
   *
   * Not one λ for the whole vector: exposure and the HSL sliders need different
   * amounts of shrinkage, and forcing them to share one lets the unpredictable
   * majority pick it for everybody.
   */
  paramLambda: number[];
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
  /** Weighted skill over the image-dependent params, sessions held out. */
  imageDependentSkill: number | null;
  /** The same number under random folds — reported for contrast, never the gate. */
  imageDependentSkillRandom: number | null;
  /** Params whose prediction is replaced by the photographer's mean delta. */
  gatedParams: string[];
  /** Skill at or below which a param is gated (0 disables gating). */
  gateThreshold: number;
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
