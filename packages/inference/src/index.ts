export {
  toStarRating,
  type ImageInput,
  type QualityAssessment,
  type AestheticAspectScore,
  type QualityModel,
  type StarRating,
} from './QualityModel.js';

// LocalOnnxModel pulls the onnxruntime-node runtime into any consumer's bundle
// (the CLI binary grows ~24MB). That is intended now that its scoring is real.
export { LocalOnnxModel } from './LocalOnnxModel.js';

export {
  clipModelManifest,
  ensureClipModel,
  resolveClipModel,
  ModelMirrorNotConfiguredError,
  CLIP_MODEL_VERSION,
  MODELS_RELEASE,
  type ResolvedModelManifest,
  type EnsureModelOptions,
} from './models/clipManifest.js';

import { LocalOnnxModel } from './LocalOnnxModel.js';
import type { QualityModel } from './QualityModel.js';
import type { EnsureModelOptions } from './models/clipManifest.js';
import { DEFAULT_PROFILE_NAME, getProfile, type RatingProfile } from './profiles.js';

export {
  BUILTIN_PROFILES,
  DEFAULT_PROFILE_NAME,
  PROFILE_NAMES,
  getProfile,
  type RatingProfile,
  type BaseProfile,
  type AspectWeightsProfile,
  type LinearEmbeddingProfile,
} from './profiles.js';

export {
  resolveProfile,
  allProfileNames,
  listUserProfileNames,
  loadProfileFile,
  parseLinearEmbeddingProfile,
} from './userProfiles.js';

/**
 * Inference backend. Only `onnx` exists today; the type stays open so a future
 * backend can be selected with `shoots rate --model <kind>`.
 */
export type ModelKind = 'onnx';

export interface QualityModelOptions extends EnsureModelOptions {
  /** Rating profile driving aesthetic merit weights. Defaults to the built-in default. */
  profile?: RatingProfile;
}

/**
 * Factory — the single place the rest of the codebase obtains a model.
 * The `onnx` backend downloads the CLIP model on first use (onnxruntime-node)
 * and fails cleanly at init() until the model mirror is built and pinned.
 */
export function createQualityModel(kind: ModelKind = 'onnx', options: QualityModelOptions = {}): QualityModel {
  const { profile, ...ensureOptions } = options;
  const resolved = profile ?? getProfile(DEFAULT_PROFILE_NAME)!;
  switch (kind) {
    case 'onnx':
      return new LocalOnnxModel(resolved, ensureOptions);
  }
}
