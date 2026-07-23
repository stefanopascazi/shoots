export {
  toStarRating,
  type ImageInput,
  type QualityAssessment,
  type QualityModel,
  type StarRating,
} from './QualityModel.js';

export { LocalStubModel } from './LocalStubModel.js';

import { LocalStubModel } from './LocalStubModel.js';
import type { QualityModel } from './QualityModel.js';

export type ModelKind = 'stub' | 'onnx';

/**
 * Factory — the single place the rest of the codebase obtains a model.
 * When the ONNX backend lands (onnxruntime-node), it is added here and
 * nothing outside `@shoots/inference` changes.
 */
export function createQualityModel(kind: ModelKind = 'stub'): QualityModel {
  switch (kind) {
    case 'stub':
      return new LocalStubModel();
    case 'onnx':
      throw new Error(
        "Model backend 'onnx' is not implemented yet (planned: onnxruntime-node). Use 'stub'.",
      );
  }
}
