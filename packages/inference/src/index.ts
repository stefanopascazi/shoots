export {
  toStarRating,
  type ImageInput,
  type QualityAssessment,
  type QualityModel,
  type StarRating,
} from './QualityModel.js';

export { LocalStubModel } from './LocalStubModel.js';
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

import { LocalStubModel } from './LocalStubModel.js';
import { LocalOnnxModel } from './LocalOnnxModel.js';
import type { QualityModel } from './QualityModel.js';

export type ModelKind = 'stub' | 'onnx';

/**
 * Factory — the single place the rest of the codebase obtains a model.
 * The `onnx` backend downloads the CLIP model on first use (onnxruntime-node)
 * and fails cleanly at init() until the model mirror is built and pinned.
 */
export function createQualityModel(kind: ModelKind = 'stub'): QualityModel {
  switch (kind) {
    case 'stub':
      return new LocalStubModel();
    case 'onnx':
      return new LocalOnnxModel();
  }
}
