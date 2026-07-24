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

/**
 * Inference backend. Only `onnx` exists today; the type stays open so a future
 * backend can be selected with `shoots rate --model <kind>`.
 */
export type ModelKind = 'onnx';

/**
 * Factory — the single place the rest of the codebase obtains a model.
 * The `onnx` backend downloads the CLIP model on first use (onnxruntime-node)
 * and fails cleanly at init() until the model mirror is built and pinned.
 */
export function createQualityModel(kind: ModelKind = 'onnx', options: EnsureModelOptions = {}): QualityModel {
  switch (kind) {
    case 'onnx':
      return new LocalOnnxModel(options);
  }
}
