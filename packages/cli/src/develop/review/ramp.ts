/**
 * What the model predicts, all the way along one control.
 *
 * The browser renders but does not predict: scaling an anchor and re-running the
 * profile is the model's own logic and reimplementing it in JavaScript would be
 * two implementations of the same thing, drifting. So the server answers the
 * question once per control — "what does this frame become at every intensity
 * from off to three times fitted?" — and sends the whole ramp.
 *
 * Sixty-one samples across the slider's travel, linearly interpolated in the
 * client. That is finer than the eye can follow during a drag, and it costs one
 * request per control instead of one per pixel of slider movement.
 */
import { intensityKey, withIntensities, type Intensities } from './intensities.js';
import { wbGains } from './color.js';
import { predictOne, resolveTreatment } from '../predict.js';
import { curveFromDevelop, HSL_CHANNELS, type AsShotMeta } from '../develop/schema.js';
import type { DevelopDataset, DevelopProfile } from '../types.js';
import type { Ramp, RampSample, SliderUniform } from './client.js';

/** How far past the fitted gain the slider can travel. */
export const MAX_SCALE = 3;

const SAMPLES = 61;

/** As-shot temperature when the file does not carry one — daylight. */
const DEFAULT_KELVIN = 5500;

/**
 * Camera Raw's ±100 sliders, as the −1..1 the shader takes.
 *
 * Exposure is the exception and stays in stops, because that is already a
 * physical unit and the shader multiplies by `exp2` of it.
 */
function toUniforms(develop: Record<string, number>): Record<SliderUniform, number> {
  const s = (key: string): number => (develop[key] ?? 0) / 100;
  return {
    exposure: develop.Exposure2012 ?? 0,
    contrast: s('Contrast2012'),
    highlights: s('Highlights2012'),
    shadows: s('Shadows2012'),
    whites: s('Whites2012'),
    blacks: s('Blacks2012'),
    clarity: s('Clarity2012'),
    texture: s('Texture'),
    dehaze: s('Dehaze'),
    vibrance: s('Vibrance'),
    saturation: s('Saturation'),
  };
}

/**
 * The point curve as knots, or `[]` when the photographer left it alone.
 *
 * Built by the *emitter*, not by a second copy of its rules. The regressor fits
 * each knot on its own and nothing stops it returning one that dips backwards —
 * on this catalog it produced 64→255, 96→255, 128→132, which renders as a
 * solarized frame. The emitter forces the outputs non-decreasing before writing
 * a sidecar, so a preview built any other way shows a photograph Lightroom will
 * never be asked to make.
 */
function toCurve(develop: Record<string, number>): [number, number][] {
  const flat = curveFromDevelop(develop);
  if (!flat) return [];
  const knots: [number, number][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) knots.push([flat[i]!, flat[i + 1]!]);
  return knots;
}

/**
 * The black-and-white mix, or null when the frame is being developed in colour.
 *
 * Without this a monochrome treatment previews in colour: the branch predicts
 * eight `GrayMixer` sliders and a conversion, and a preview that ignores both
 * shows a photograph whose every colour decision has been made and then
 * discarded. Judging the intensity of a tonal control on the wrong medium is not
 * a smaller error than judging it on the wrong frame.
 */
function toMono(develop: Record<string, number>): number[] | null {
  return HSL_CHANNELS.map((ch) => (develop[`GrayMixer${ch}`] ?? 0) / 100);
}

/** White balance as the per-channel linear gain from as-shot to chosen. */
function toWb(develop: Record<string, number>, meta: AsShotMeta): [number, number, number] {
  const asShot = meta.tempAsShot && meta.tempAsShot > 0 ? meta.tempAsShot : DEFAULT_KELVIN;
  const chosen = develop.Temperature && develop.Temperature > 0 ? develop.Temperature : asShot;
  const tintAsShot = meta.tintAsShot ?? 0;
  return wbGains(asShot, chosen, tintAsShot, develop.Tint ?? tintAsShot);
}

export interface RampInput {
  record: DevelopDataset['results'][number];
  sessionMean: number[];
  /** Which anchored parameter this control scales, and reads out in. */
  family: string;
  /** Which branch's anchors it scales — the frame belongs to this treatment. */
  treatment: string;
}

/**
 * Predict one frame at every intensity of one control.
 *
 * The curve and the parametric curve are read once, at the fitted gain, rather
 * than per sample: a control scales its own family's anchors and nothing else,
 * so no other parameter moves along the ramp. Sending 61 copies of an unchanging
 * 9-knot curve would be most of the payload and none of the information.
 */
export function buildRamp(
  profile: DevelopProfile,
  initial: Intensities,
  input: RampInput,
): Ramp {
  const key = intensityKey(input.treatment, input.family);
  const predict = (scale: number): Record<string, number> =>
    withIntensities(profile, { ...initial, [key]: scale }, () => {
      const treatment = resolveTreatment(profile, input.record, 'auto');
      return predictOne(profile, input.record, treatment, input.sessionMean).develop;
    });

  const samples: RampSample[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const scale = (i / (SAMPLES - 1)) * MAX_SCALE;
    const develop = predict(scale);
    samples.push({
      scale,
      value: develop[input.family] ?? 0,
      wb: toWb(develop, input.record.asShot),
      u: toUniforms(develop),
    });
  }

  const fitted = predict(1);
  return {
    mono: input.treatment === 'bw' ? toMono(fitted) : null,
    curve: toCurve(fitted),
    parametric: [
      (fitted.ParametricHighlights ?? 0) / 100,
      (fitted.ParametricLights ?? 0) / 100,
      (fitted.ParametricDarks ?? 0) / 100,
      (fitted.ParametricShadows ?? 0) / 100,
    ],
    samples,
  };
}
