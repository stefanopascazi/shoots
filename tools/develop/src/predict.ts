/**
 * Inference: a trained DevelopProfile + a new image's develop-export record →
 * the predicted develop-setting vector (absolute crs values). Deltas are
 * predicted in standardized space, de-standardized, then decoded back to
 * absolute ACR units and clamped to valid ranges.
 */
import { DEVELOP_PARAMS, PARAM_COUNT, SCHEMA_VERSION, decodeDelta } from './develop/schema.js';
import { assembleFeatures } from './develop/assemble.js';
import type { DevelopExportResult, DevelopProfile } from './types.js';

export interface Prediction {
  file: string;
  /** Predicted absolute crs develop values, keyed by tag. */
  develop: Record<string, number>;
}

/** Throw a clear error if a profile cannot be applied to a dataset/record. */
export function assertApplicable(profile: DevelopProfile, model: string, embeddingDim: number, colorDim: number): void {
  if (profile.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`profile schema v${profile.schemaVersion} != tool schema v${SCHEMA_VERSION}; retrain`);
  }
  if (profile.embeddingModel !== model) {
    throw new Error(`profile embedding model '${profile.embeddingModel}' != dataset model '${model}'`);
  }
  if (profile.embeddingDim !== embeddingDim) {
    throw new Error(`profile embedding dim ${profile.embeddingDim} != dataset dim ${embeddingDim}`);
  }
  if (profile.colorDim !== colorDim) {
    throw new Error(`profile color dim ${profile.colorDim} != dataset color dim ${colorDim}`);
  }
}

export function predictOne(profile: DevelopProfile, result: DevelopExportResult): Prediction {
  const meta = result.asShot;
  const x = assembleFeatures(result.embedding, result.features, meta);
  const develop: Record<string, number> = {};
  for (let k = 0; k < PARAM_COUNT; k++) {
    const param = DEVELOP_PARAMS[k]!;
    let xStdDot = profile.bias[k]!;
    const w = profile.weights[k]!;
    for (let j = 0; j < x.length; j++) {
      xStdDot += w[j]! * ((x[j]! - profile.featureMean[j]!) / profile.featureStd[j]!);
    }
    const delta = xStdDot * profile.deltaStd[k]! + profile.deltaMean[k]!;
    const abs = decodeDelta(param, delta, meta);
    develop[param.key] = Math.round(abs * 1e4) / 1e4;
  }
  return { file: result.file, develop };
}
