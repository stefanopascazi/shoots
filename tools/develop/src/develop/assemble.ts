/**
 * Turn a `shoots develop-export` record into the model's input feature vector
 * and (at train time) its target delta vector, over a given set of parameters
 * (a treatment's shared+branch list). Shared by training and inference so the two
 * never drift.
 *
 * Feature vector layout: [ CLIP embedding | color features | as-shot scalars ].
 * The as-shot scalars (log WB temperature, log ISO, exposure compensation) make
 * the capture state explicit — the accuracy lever for WB and exposure.
 */
import { encodeDelta, decodeDelta, type AsShotMeta, type DevelopParam } from './schema.js';

/** Number of appended as-shot scalar features. */
export const AS_SHOT_DIM = 3;

export function asShotFeatures(meta: AsShotMeta): number[] {
  const temp = meta.tempAsShot && meta.tempAsShot > 0 ? meta.tempAsShot : 5500;
  const iso = meta.iso && meta.iso > 0 ? meta.iso : 100;
  return [Math.log(temp), Math.log(iso), meta.exposureComp ?? 0];
}

export function assembleFeatures(embedding: number[], color: number[], meta: AsShotMeta): number[] {
  return [...embedding, ...color, ...asShotFeatures(meta)];
}

/** The absolute develop value effectively applied for a param (present, or the ACR default). */
export function actualAbsOne(param: DevelopParam, develop: Record<string, number>, meta: AsShotMeta): number {
  const present = develop[param.key];
  if (present !== undefined && Number.isFinite(present)) return present;
  return decodeDelta(param, 0, meta); // default ⇒ delta 0
}

export function actualAbsVec(params: DevelopParam[], develop: Record<string, number>, meta: AsShotMeta): number[] {
  return params.map((p) => actualAbsOne(p, develop, meta));
}

/** The target delta vector for one image over the given params. */
export function targetDeltas(params: DevelopParam[], develop: Record<string, number>, meta: AsShotMeta): number[] {
  return params.map((p) => encodeDelta(p, actualAbsOne(p, develop, meta), meta));
}
