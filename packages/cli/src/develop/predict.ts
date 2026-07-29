/**
 * Inference: a trained (branched) DevelopProfile + a new image's develop-export
 * record → the predicted develop-setting vector (absolute crs values) for the
 * chosen treatment (colour or B&W). Deltas are predicted in standardized space,
 * de-standardized, decoded to absolute ACR units and clamped.
 */
import { SCHEMA_VERSION, decodeDelta, paramsForTreatment, type Treatment } from './develop/schema.js';
import { assembleFeatures, profileOneHot } from './develop/assemble.js';
import type { DevelopDataset, DevelopExportResult, DevelopProfile } from './types.js';

export interface Prediction {
  file: string;
  treatment: Treatment;
  develop: Record<string, number>;
}

/** The dataset-level facts a profile has to agree with to be applicable. */
type DatasetGuards = Pick<DevelopDataset, 'model' | 'dim' | 'colorDim' | 'baseline'>;

export function assertApplicable(profile: DevelopProfile, dataset: DatasetGuards): void {
  if (profile.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`profile schema v${profile.schemaVersion} != tool schema v${SCHEMA_VERSION}; retrain`);
  }
  if (profile.embeddingModel !== dataset.model) {
    throw new Error(`profile embedding model '${profile.embeddingModel}' != dataset model '${dataset.model}'`);
  }
  if (profile.embeddingDim !== dataset.dim) {
    throw new Error(`profile embedding dim ${profile.embeddingDim} != dataset dim ${dataset.dim}`);
  }
  if (profile.colorDim !== dataset.colorDim) {
    throw new Error(`profile color dim ${profile.colorDim} != dataset color dim ${dataset.colorDim}`);
  }
  // The photometric features are only comparable within one baseline render
  // strategy: an embedded camera JPEG and a neutral external render put the same
  // photograph at different luminance, contrast and white point. Mixing them
  // silently feeds the model a feature vector from a space it never saw, and
  // nothing downstream fails loudly — the predictions just come out wrong. The
  // dimensions match either way, so this is the only place it can be caught.
  if (!dataset.baseline) {
    throw new Error(
      `dataset does not record which baseline render it was exported with, so it cannot be ` +
        `checked against the profile's ('${profile.baseline}') — re-export it with ` +
        `\`--baseline ${profile.baseline}\``,
    );
  }
  if (profile.baseline !== dataset.baseline) {
    throw new Error(
      `profile was trained on baseline '${profile.baseline}' but the dataset was exported with ` +
        `'${dataset.baseline}' — the colour features are not comparable across baselines. ` +
        `Re-export with \`--baseline ${profile.baseline}\`.`,
    );
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
