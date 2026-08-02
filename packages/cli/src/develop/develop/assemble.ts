/**
 * Turn a `shoots develop-export` record into the model's input feature vector
 * and (at train time) its target delta vector, over a given set of parameters
 * (a treatment's shared+branch list). Shared by training and inference so the two
 * never drift.
 *
 * Feature vector layout:
 *   [ CLIP embedding | colour features | session mean | as-shot scalars ]
 *
 * The embedding comes **first** so a fold-local projection can replace that block
 * without knowing anything about the rest (see the PCA transform in train.ts).
 * The as-shot scalars (log WB temperature, log ISO, exposure compensation) make
 * the capture state explicit — the accuracy lever for WB and exposure. The
 * session mean says what the rest of the shoot looks like, which is where most
 * of the target variance actually lives (see develop/session.ts).
 */
import { encodeDelta, decodeDelta, type AsShotMeta, type DevelopParam } from './schema.js';

/** Number of appended as-shot scalar features. */
export const AS_SHOT_DIM = 5;

export function asShotFeatures(meta: AsShotMeta): number[] {
  const temp = meta.tempAsShot && meta.tempAsShot > 0 ? meta.tempAsShot : 5500;
  const iso = meta.iso && meta.iso > 0 ? meta.iso : 100;
  // The clock is circular: 23:00 and 01:00 are an hour apart, not twenty-two. A
  // raw hour number would tell the model the opposite, so it goes in as a point
  // on the unit circle. An unknown hour lands at the origin — equidistant from
  // every time of day, which is exactly what "we don't know" should mean.
  const hour = typeof meta.hour === 'number' && meta.hour >= 0 ? meta.hour : null;
  const angle = hour === null ? 0 : (2 * Math.PI * hour) / 24;
  return [
    Math.log(temp),
    Math.log(iso),
    meta.exposureComp ?? 0,
    hour === null ? 0 : Math.sin(angle),
    hour === null ? 0 : Math.cos(angle),
  ];
}

export function assembleFeatures(
  embedding: number[],
  color: number[],
  sessionMean: number[],
  meta: AsShotMeta,
): number[] {
  return [...embedding, ...color, ...sessionMean, ...asShotFeatures(meta)];
}

/**
 * One photograph as the two-head model reads it: `[ embedding | colour | as-shot ]`.
 *
 * Everything the frame itself states, and nothing about its shoot. The session
 * description is no longer a block bolted onto the end — it is the *mean of this
 * very vector* over the folder, which is what makes the split below exact.
 *
 * The embedding stays raw here; each head projects it with its own fold-local
 * PCA, so the layout a mask indexes into is `[ keep | colour | AS_SHOT_DIM ]`.
 */
export function baseFeatures(embedding: number[], color: number[], meta: AsShotMeta): number[] {
  return [...embedding, ...color, ...asShotFeatures(meta)];
}

/**
 * What is different about this frame, relative to the rest of its shoot.
 *
 * The whole point of the decomposition. Regressing on the raw frame vector let
 * ridge answer every question with the session average — the session block was a
 * near-noiseless predictor of the session's own offset, so it absorbed the budget
 * and the per-frame columns came out at a tenth of their honest size. Subtracting
 * the session mean makes the two blocks orthogonal: the level head can only see
 * what the shoot looks like, and this one can only see what *this* photograph does
 * that its neighbours do not. A backlit frame in a shoot of open shade now differs
 * from its neighbours by exactly the amount its highlights are blown, and that is
 * the only thing the frame head is shown.
 */
export function deviationFrom(base: number[], sessionMean: number[]): number[] {
  return base.map((v, i) => v - (sessionMean[i] ?? 0));
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
