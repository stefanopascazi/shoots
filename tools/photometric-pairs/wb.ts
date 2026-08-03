/**
 * Colour maths for the synthetic degradations.
 *
 * A white-balance error and an exposure error are, in scene-linear light, just
 * per-channel multiplications — which is the whole reason this tool perturbs the
 * *linear* render rather than re-running the RAW developer with different flags.
 * Everything here produces those three gains.
 */

/** Nominal anchor for a relative temperature shift. See {@link wbGains}. */
export const ANCHOR_KELVIN = 5500;

/**
 * Planckian locus in CIE 1931 xy, Kim et al.'s cubic approximation.
 * Valid 1667K–25000K, which covers anything a camera will ever meter.
 */
function kelvinToXy(kelvin: number): [number, number] {
  const t = Math.min(25000, Math.max(1667, kelvin));
  const t2 = t * t;
  const t3 = t2 * t;
  const x =
    t <= 4000
      ? -0.2661239e9 / t3 - 0.2343589e6 / t2 + 0.8776956e3 / t + 0.17991
      : -3.0258469e9 / t3 + 2.1070379e6 / t2 + 0.2226347e3 / t + 0.24039;
  const x2 = x * x;
  const x3 = x2 * x;
  let y: number;
  if (t <= 2222) y = -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683;
  else if (t <= 4000) y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
  else y = 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}

/** xy chromaticity at Y=1 as a linear sRGB triple (unnormalised). */
function xyToLinearSrgb(x: number, y: number): [number, number, number] {
  const X = x / y;
  const Y = 1;
  const Z = (1 - x - y) / y;
  return [
    3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 * Y + 0.041556 * Z,
    0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
  ];
}

/** Kelvin ↔ mired. Mired is the unit a temperature *shift* is uniform in. */
export const kelvinToMired = (k: number): number => 1e6 / k;
export const miredToKelvin = (m: number): number => 1e6 / m;

/**
 * Per-channel linear gains for a white-balance error.
 *
 * The render this is applied to already carries the camera's as-shot balance, so
 * the shift has to be *relative* — but "relative" in Kelvin is meaningless (200K
 * at 3000K is a colour cast, at 9000K it is invisible). Mired is the unit in
 * which a shift is roughly perceptually uniform, so the delta is sampled there
 * and converted around a nominal anchor. The residual dependence on the true
 * as-shot temperature is what that approximation costs, and it is small enough
 * that the label stays honest; the exact as-shot Kelvin is recorded per file by
 * `develop export`, so a later revision can anchor per image instead.
 *
 * @param deltaMired Positive = cooler render (the scene is being told it was
 * shot warmer than it was), matching ACR's Temperature direction.
 * @param tint Green–magenta, in units where ±20 is a clearly visible cast.
 */
export function wbGains(deltaMired: number, tint: number): [number, number, number] {
  const from = xyToLinearSrgb(...kelvinToXy(ANCHOR_KELVIN));
  const to = xyToLinearSrgb(...kelvinToXy(miredToKelvin(kelvinToMired(ANCHOR_KELVIN) + deltaMired)));
  // Divide, then re-normalise on green: a white balance is a chromaticity change,
  // and any overall scale it carries belongs to the exposure term instead.
  const raw: [number, number, number] = [from[0] / to[0], from[1] / to[1], from[2] / to[2]];
  const g = raw[1];
  // Positive tint pushes magenta, i.e. holds green back.
  const tintGain = 1 - tint * 0.0025;
  return [raw[0] / g, tintGain, raw[2] / g];
}

/** Exposure error as a linear multiplier. */
export const evGain = (ev: number): number => 2 ** ev;

/** sRGB opto-electronic transfer function, linear [0,1] → encoded [0,1]. */
export function srgbEncode(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

/**
 * A 16-bit-linear → 8-bit-sRGB lookup table for one channel at one gain.
 *
 * Built once per variant and then applied by table lookup, because the transfer
 * function is the only expensive arithmetic in the pixel loop and there are only
 * 65536 distinct inputs.
 */
export function buildLut(gain: number): Uint8Array {
  const lut = new Uint8Array(65536);
  for (let v = 0; v < 65536; v++) {
    lut[v] = Math.round(srgbEncode((v / 65535) * gain) * 255);
  }
  return lut;
}
