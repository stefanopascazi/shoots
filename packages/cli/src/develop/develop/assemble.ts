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

/**
 * One-hot encode the base rendering (camera profile + Look) against a per-branch
 * vocabulary, appended to the feature vector as a conditioning signal. The render
 * sets the colour starting point before any slider touches it.
 *
 * A render outside the vocabulary maps to all-zeros. That is a *last resort*, not
 * a neutral value: at training almost every row has some column set, so the
 * columns standardize to a mean near their frequency, and an all-zero vector
 * lands well below anything the model was fitted on. Callers holding a trained
 * profile must therefore substitute the branch's own default render rather than
 * pass nothing — a file that has not been edited yet carries no crs at all, so
 * this is the *normal* case at prediction time, not an edge one.
 */
export function renderOneHot(key: string | undefined, vocab: string[]): number[] {
  const v = new Array<number>(vocab.length).fill(0);
  if (key) {
    const i = vocab.indexOf(key);
    if (i >= 0) v[i] = 1;
  }
  return v;
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
