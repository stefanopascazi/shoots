/**
 * Inference: a trained (branched) DevelopProfile + a new image's develop-export
 * record → the predicted develop-setting vector (absolute crs values) for the
 * chosen treatment (colour or B&W). Deltas are predicted in standardized space,
 * de-standardized, decoded to absolute ACR units and clamped.
 */
import { SCHEMA_VERSION, decodeDelta, paramsForTreatment, type Treatment } from './develop/schema.js';
import { assembleFeatures, profileOneHot } from './develop/assemble.js';
import type { DevelopExportResult, DevelopProfile } from './types.js';

export interface Prediction {
  file: string;
  treatment: Treatment;
  develop: Record<string, number>;
}

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

/** Resolve which treatment branch to apply for a record. */
export function resolveTreatment(profile: DevelopProfile, result: DevelopExportResult, requested: Treatment | 'auto'): Treatment {
  const want: Treatment = requested === 'auto' ? (result.treatment ?? 'color') : requested;
  if (profile.branches[want]) return want;
  // Fall back to whichever branch the profile actually has.
  const available = (['color', 'bw'] as const).find((t) => profile.branches[t]);
  if (!available) throw new Error('profile has no trained branch');
  return available;
}

export function predictOne(profile: DevelopProfile, result: DevelopExportResult, treatment: Treatment): Prediction {
  const branch = profile.branches[treatment];
  if (!branch) throw new Error(`profile has no '${treatment}' branch`);
  const params = paramsForTreatment(treatment);
  const meta = result.asShot;
  const x = [...assembleFeatures(result.embedding, result.features, meta), ...profileOneHot(result.baseProfile, branch.profileVocab)];
  const gated = new Set(branch.gatedParams ?? []);
  const develop: Record<string, number> = {};
  for (let k = 0; k < params.length; k++) {
    const param = params[k]!;
    // Gated: held-out evidence says the model does not beat the photographer's
    // own constant for this parameter, so emit the constant. A prediction that
    // scores below the mean is worse than no prediction — it moves a slider
    // away from where this photographer would have left it.
    let delta = branch.deltaMean[k]!;
    if (!gated.has(param.key)) {
      let dot = branch.bias[k]!;
      const w = branch.weights[k]!;
      for (let j = 0; j < x.length; j++) {
        dot += w[j]! * ((x[j]! - branch.featureMean[j]!) / branch.featureStd[j]!);
      }
      delta = dot * branch.deltaStd[k]! + branch.deltaMean[k]!;
    }
    develop[param.key] = Math.round(decodeDelta(param, delta, meta) * 1e4) / 1e4;
  }
  return { file: result.file, treatment, develop };
}
