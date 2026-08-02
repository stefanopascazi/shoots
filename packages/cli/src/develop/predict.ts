/**
 * Inference: a trained (branched) DevelopProfile + a new image's develop-export
 * record → the predicted develop-setting vector (absolute crs values) for the
 * chosen treatment (colour or B&W). Deltas are predicted in standardized space,
 * de-standardized, decoded to absolute ACR units and clamped.
 */
import {
  SCHEMA_VERSION,
  decodeDelta,
  paramsForTreatment,
  parseRenderKey,
  renderKey,
  type RenderProfile,
  type Treatment,
} from './develop/schema.js';
import { baseFeatures, deviationFrom, renderOneHot } from './develop/assemble.js';
import { applyPca } from './train/pca.js';
import { applyOffset } from './feedback/calibrate.js';
import type { PredictedEdit } from './adapters/types.js';
import type { BranchModel, DevelopDataset, DevelopExportResult, DevelopProfile, HeadModel } from './types.js';

export interface Prediction {
  file: string;
  treatment: Treatment;
  develop: Record<string, number>;
  /** The base rendering these values are meant to sit on (written to the sidecar). */
  render: PredictedEdit['render'];
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
    // Almost always an upgrade rather than a mistake: a release that adds a
    // photometric feature widens this vector, and every profile fitted before it
    // is stale. Say so, because "50 != 44" reads like a bug in the tool when it
    // is really a one-line fix the photographer can run.
    const older = profile.colorDim < dataset.colorDim ? 'profile' : 'dataset';
    throw new Error(
      `profile color dim ${profile.colorDim} != dataset color dim ${dataset.colorDim} — ` +
        `the ${older} was built with a different version of shoots. ` +
        'Re-run `shoots develop init <your-edited-catalog>` to refit the profile against the current features ' +
        '(`shoots release-notes` shows the full note).',
    );
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

/**
 * The rendering to condition on and to write out for one image.
 *
 * An unedited file states no rendering at all — that is the normal case here,
 * since the whole point is to predict for photographs nobody has touched. The
 * branch's own default stands in, so the model is asked the question it was
 * trained on ("what do you do starting from Adobe Color?") instead of being fed
 * an all-zero one-hot that matches nothing it ever saw. An explicit `override`
 * wins over both: it is the only way to aim a profile at a rendering the catalog
 * has moved on from.
 */
export function resolveRender(
  branch: BranchModel,
  result: DevelopExportResult,
  override?: string,
): PredictedEdit['render'] {
  let chosen: RenderProfile;
  if (override) {
    chosen = parseRenderKey(override);
  } else {
    const stated: RenderProfile = { profile: result.baseProfile, look: result.look };
    const key = renderKey(stated);
    chosen = key && branch.renderVocab.includes(key) ? stated : branch.defaultRender;
  }
  const lookXml = chosen.look ? branch.looks?.[chosen.look] : undefined;
  return {
    ...(chosen.profile ? { profile: chosen.profile } : {}),
    ...(chosen.look ? { look: chosen.look } : {}),
    ...(lookXml ? { lookXml } : {}),
  };
}

/**
 * One head's contribution for parameter `k`, in delta space.
 *
 * Three things happen in order, and the order matters: the raw ridge output is
 * de-standardized, the gate may replace it with the head's own constant, and the
 * de-shrinking slope restores the reach that shrinkage took off. A gated head
 * emits its target mean — for the level head that is the photographer's
 * catalog-wide constant, for the frame head it is "no per-frame modulation".
 */
function headDelta(head: HeadModel, x: number[], k: number): number {
  const mean = head.targetMean[k]!;
  if (head.gated[k]) return mean;
  let dot = head.bias[k]!;
  const w = head.weights[k]!;
  for (let j = 0; j < x.length; j++) {
    dot += w[j]! * ((x[j]! - head.featureMean[j]!) / head.featureStd[j]!);
  }
  const raw = dot * head.targetStd[k]! + mean;
  return mean + (head.response[k] ?? 1) * (raw - mean);
}

/** The embedding block as one head consumes it: raw, projected, or dropped. */
function projectEmbedding(head: HeadModel, base: number[], rawDim: number): number[] {
  const rest = base.slice(rawDim);
  if (head.embeddingFeatures === 0) return rest;
  const embedding = base.slice(0, rawDim);
  return head.embeddingPca ? [...applyPca(embedding, head.embeddingPca), ...rest] : [...embedding, ...rest];
}

/**
 * @param sessionMean The mean of {@link baseFeatures} over this photograph's whole
 * shoot — the same vector the trainer described the session with. A frame alone in
 * its folder is its own mean, so its deviation is zero and only the level head
 * speaks; that is the correct degradation, not a failure.
 */
export function predictOne(
  profile: DevelopProfile,
  result: DevelopExportResult,
  treatment: Treatment,
  sessionMean: number[],
  renderOverride?: string,
): Prediction {
  const branch = profile.branches[treatment];
  if (!branch) throw new Error(`profile has no '${treatment}' branch`);
  const params = paramsForTreatment(treatment);
  const meta = result.asShot;
  const render = resolveRender(branch, result, renderOverride);

  const base = baseFeatures(result.embedding, result.features, meta);
  const rawDim = result.embedding.length;
  // Where the shoot sits, and what this frame does differently. The split is the
  // whole model: without it the shoot average answered both questions and every
  // frame in a folder came back with the same numbers.
  const levelX = projectEmbedding(branch.level, [...sessionMean], rawDim)
    .concat(renderOneHot(renderKey(render), branch.renderVocab));
  const frameX = projectEmbedding(branch.frame, deviationFrom(base, sessionMean), rawDim);

  // Measured on the photographer's own corrections rather than on the catalog,
  // so it is applied after the model has spoken — in absolute units, where the
  // correction was observed — and never merged into the weights. A gated
  // parameter is offset too: it emits a constant, and a constant that is
  // reliably wrong is precisely what this fixes.
  const offsets = profile.calibration?.offsets[treatment] ?? {};
  const develop: Record<string, number> = {};
  for (let k = 0; k < params.length; k++) {
    const param = params[k]!;
    const delta = headDelta(branch.level, levelX, k) + headDelta(branch.frame, frameX, k);
    const offset = offsets[param.key];
    const value = offset === undefined
      ? decodeDelta(param, delta, meta)
      : applyOffset(param, decodeDelta(param, delta, meta), offset);
    develop[param.key] = Math.round(value * 1e4) / 1e4;
  }
  return { file: result.file, treatment, develop, render };
}
