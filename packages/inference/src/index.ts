export {
  toStarRating,
  type ImageInput,
  type QualityAssessment,
  type QualityModel,
  type StarRating,
} from './QualityModel.js';

export { LocalStubModel } from './LocalStubModel.js';
// NOTE: LocalOnnxModel is intentionally NOT re-exported yet. Re-exporting it
// pulls its `import('onnxruntime-node')` into any consumer's bundle (the CLI
// binary grows ~24MB) even though the backend is not wired. Export it — and
// instantiate it in createQualityModel — once scoring lands.

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
import type { QualityModel } from './QualityModel.js';

export type ModelKind = 'stub' | 'onnx';

/**
 * Factory — the single place the rest of the codebase obtains a model.
 *
 * The `onnx` backend (LocalOnnxModel) is scaffolded and its provisioning is
 * wired, but scoring is not implemented yet — so it is intentionally NOT
 * instantiated here. Keeping it out of this graph keeps the onnxruntime-node
 * runtime out of the shipped CLI binary until the backend actually works. Flip
 * this to `new LocalOnnxModel()` once scoring lands (that is when the ~24MB
 * runtime embedding is justified).
 */
export function createQualityModel(kind: ModelKind = 'stub'): QualityModel {
  switch (kind) {
    case 'stub':
      return new LocalStubModel();
    case 'onnx':
      throw new Error(
        "Model backend 'onnx' is scaffolded but scoring is not implemented yet. Use 'stub'.",
      );
  }
}
