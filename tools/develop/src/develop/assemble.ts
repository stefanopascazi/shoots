/**
 * Turn a `shoots develop-export` record into the model's input feature vector
 * and (at train time) its target delta vector. Shared by training and inference
 * so the two never drift.
 *
 * Feature vector layout: [ CLIP embedding | color features | as-shot scalars ].
 * The as-shot scalars (log WB temperature, log ISO, exposure compensation) make
 * the capture state explicit — the plan's "accuracy lever n.1" for white balance
 * and exposure, which are camera-relative.
 */
import { DEVELOP_PARAMS, encodeDelta, decodeDelta, type AsShotMeta } from './schema.js';

/** Number of appended as-shot scalar features. */
export const AS_SHOT_DIM = 3;

/** The as-shot scalars, in a fixed order, with sane fallbacks. */
export function asShotFeatures(meta: AsShotMeta): number[] {
  const temp = meta.tempAsShot && meta.tempAsShot > 0 ? meta.tempAsShot : 5500;
  const iso = meta.iso && meta.iso > 0 ? meta.iso : 100;
  return [Math.log(temp), Math.log(iso), meta.exposureComp ?? 0];
}

/** Assemble the full input feature vector for one image. */
export function assembleFeatures(embedding: number[], color: number[], meta: AsShotMeta): number[] {
  return [...embedding, ...color, ...asShotFeatures(meta)];
}

/**
 * The absolute develop value the photographer effectively applied for a param:
 * the present crs value, or the ACR default (which reduces to a zero delta).
 */
export function actualAbs(paramIndex: number, develop: Record<string, number>, meta: AsShotMeta): number {
  const param = DEVELOP_PARAMS[paramIndex]!;
  const present = develop[param.key];
  if (present !== undefined && Number.isFinite(present)) return present;
  return decodeDelta(param, 0, meta); // default ⇒ delta 0
}

/** The target delta vector (length = param count) for one image. */
export function targetDeltas(develop: Record<string, number>, meta: AsShotMeta): number[] {
  return DEVELOP_PARAMS.map((param, i) => encodeDelta(param, actualAbs(i, develop, meta), meta));
}
