/**
 * Detail profiles ("styles"): a correction on top of the general profile.
 *
 * A style is never a model of its own. It is trained on a subset of edits — the
 * black-and-white work, the warm weddings — as the *difference* between what the
 * photographer did there and what the general profile predicts for the same
 * frames, and applied as that difference on top of the general prediction. So a
 * style with twenty photographs moves only what those twenty consistently do
 * differently and inherits everything else, instead of being a weak model of
 * twenty photographs.
 *
 * Measured in each parameter's correction space (see feedback/calibrate.ts) and
 * with one shoot as one vote: a shoot is many frames edited by pasting one
 * decision across them, and counting frames would count that decision many times.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { developStylesDir } from '@shoots/core';
import { paramsForTreatment, type Treatment } from '../develop/schema.js';
import { applyOffset } from '../feedback/calibrate.js';
import type { Prediction } from '../predict.js';
import type { DevelopProfile } from '../types.js';

/** How one parameter differs in this style, and how much of that is trusted. */
export interface StyleParam {
  /** Mean departure from the general profile, shoots weighted equally. */
  mean: number;
  /** Standard error of that mean. */
  se: number;
  /** max(0, 1 − se²/mean²): near 1 when the departure is consistent, 0 when it is within one standard error. */
  shrink: number;
  /** What is applied at strength 1: shrink × mean, in correction space. */
  offset: number;
}

export interface StyleBranch {
  images: number;
  shoots: number;
  params: Record<string, StyleParam>;
}

export interface DevelopStyle {
  type: 'develop-style';
  name: string;
  description?: string;
  /** The general profile the departures were measured against — a retrain makes them stale. */
  base: { name: string; trainedAt: string };
  trainedAt: string;
  toolVersion?: string;
  branches: Partial<Record<Treatment, StyleBranch>>;
}

/** One edited frame's departure from the general prediction, per parameter. */
export interface StyleObservation {
  shoot: string;
  residuals: Record<string, number>;
}

const avg = (v: readonly number[]): number => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
const sdOf = (v: readonly number[]): number => {
  if (v.length < 2) return 0;
  const m = avg(v);
  return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1));
};

/**
 * One parameter's style departure from its observations.
 *
 * The standard error is taken across shoot means when there are enough shoots to
 * have a spread (three or more). With one or two shoots there is no such spread,
 * so the frame spread stands in — divided by the shoot count, not the frame
 * count, because frames within a shoot are one decision.
 */
export function fitStyleParam(byShoot: ReadonlyMap<string, readonly number[]>): StyleParam {
  const shootMeans = [...byShoot.values()].filter((v) => v.length).map(avg);
  if (!shootMeans.length) return { mean: 0, se: 0, shrink: 0, offset: 0 };
  const mean = avg(shootMeans);
  const se =
    shootMeans.length >= 3
      ? sdOf(shootMeans) / Math.sqrt(shootMeans.length)
      : sdOf([...byShoot.values()].flat()) / Math.sqrt(shootMeans.length);
  // Positive-part James–Stein: a departure smaller than its own standard error is
  // indistinguishable from noise and contributes nothing; a softer rule kept two
  // thirds of every noisy hue slider on a real catalog.
  const shrink = mean === 0 ? 0 : se === 0 ? 1 : Math.max(0, 1 - (se * se) / (mean * mean));
  return { mean, se, shrink, offset: shrink * mean };
}

export function fitStyleBranch(observations: readonly StyleObservation[], treatment: Treatment): StyleBranch {
  const params: Record<string, StyleParam> = {};
  for (const p of paramsForTreatment(treatment)) {
    const byShoot = new Map<string, number[]>();
    for (const o of observations) {
      const r = o.residuals[p.key];
      if (r === undefined || !Number.isFinite(r)) continue;
      byShoot.set(o.shoot, [...(byShoot.get(o.shoot) ?? []), r]);
    }
    if (byShoot.size) params[p.key] = fitStyleParam(byShoot);
  }
  return { images: observations.length, shoots: new Set(observations.map((o) => o.shoot)).size, params };
}

/**
 * A general prediction with the style's departures applied.
 *
 * `strength` scales every offset together: 0 is the general profile, 1 the style
 * as measured. A treatment the style was not trained on passes through unchanged.
 */
export function applyStyle(prediction: Prediction, style: DevelopStyle, strength = 1): Prediction {
  const branch = style.branches[prediction.treatment];
  if (!branch || strength === 0) return prediction;
  const develop = { ...prediction.develop };
  for (const p of paramsForTreatment(prediction.treatment)) {
    const offset = branch.params[p.key]?.offset;
    if (!offset || develop[p.key] === undefined) continue;
    develop[p.key] = Math.round(applyOffset(p, develop[p.key]!, strength * offset) * 1e4) / 1e4;
  }
  return { ...prediction, develop };
}

/** A style by name (under the styles directory) or by path to its JSON. */
export function resolveStylePath(nameOrPath: string): string {
  if (nameOrPath.endsWith('.json') || existsSync(nameOrPath)) return path.resolve(nameOrPath);
  return path.join(developStylesDir(), `${nameOrPath}.json`);
}

/**
 * Read a style and say what it rides on — and warn when it was measured against
 * another training of the general profile, whose predictions it no longer offsets.
 */
export async function loadStyle(
  nameOrPath: string,
  profile: Pick<DevelopProfile, 'name' | 'trainedAt'>,
  log: (message: string) => void,
): Promise<DevelopStyle> {
  const file = resolveStylePath(nameOrPath);
  if (!existsSync(file)) throw new Error(`no style at ${file} — \`shoots develop style list\` shows the saved ones`);
  const style = JSON.parse(await readFile(file, 'utf8')) as DevelopStyle;
  if (style.type !== 'develop-style') throw new Error(`${file} is not a develop style`);
  log(`Style '${style.name}' on top of '${profile.name}'`);
  if (style.base.trainedAt !== profile.trainedAt) {
    log(
      `warn: style '${style.name}' was measured against another training of the general profile — ` +
        'its departures describe a model that no longer exists; re-run `shoots develop style train`',
    );
  }
  return style;
}

/** Names a style can be saved under: they become file names. */
export function validStyleName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(name) && !name.endsWith('.json');
}
