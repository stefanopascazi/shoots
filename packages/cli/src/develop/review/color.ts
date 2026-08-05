/**
 * The colorimetry the preview and the shader agree on.
 *
 * Everything here is *exact*: a white-balance move and an exposure move are
 * per-channel multiplications in scene-linear light, which is precisely what a
 * RAW developer does with them. Nothing in this file is an approximation of
 * Camera Raw — it is the physics both of them implement.
 *
 * The approximate part of the preview — the tone controls, local contrast, the
 * base rendering — lives in the shader (`glsl.ts`), where it is applied in float
 * on the GPU and can be read as the sequence of operations it is.
 */

/** Scene-linear RGB, 16-bit, as the RAW developer produced it. */
export interface LinearImage {
  data: Uint16Array;
  width: number;
  height: number;
}

/** Rec.709 luminance weights — the shader uses the same three numbers. */
export const LUMA: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

/**
 * The Planckian locus in CIE xy, via Kim et al.'s cubic approximation.
 *
 * Valid from 1667K to 25000K, which covers everything Camera Raw's temperature
 * slider can express.
 */
function planckianXy(kelvin: number): [number, number] {
  const t = Math.min(25000, Math.max(1667, kelvin));
  const t2 = t * t;
  const t3 = t2 * t;
  const x =
    t <= 4000
      ? -0.2661239e9 / t3 - 0.2343589e6 / t2 + 0.8776956e3 / t + 0.17991
      : -3.0258469e9 / t3 + 2.1070379e6 / t2 + 0.2226347e3 / t + 0.24039;
  const x2 = x * x;
  const x3 = x2 * x;
  const y =
    t <= 2222
      ? -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683
      : t <= 4000
        ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
        : 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}

/** A colour temperature as linear sRGB, normalised on Y. */
function kelvinToLinearRgb(kelvin: number): [number, number, number] {
  const [x, y] = planckianXy(kelvin);
  const X = x / y;
  const Z = (1 - x - y) / y;
  return [
    3.2404542 * X - 1.5371385 - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 + 0.041556 * Z,
    0.0556434 * X - 0.2040259 + 1.0572252 * Z,
  ];
}

/**
 * Per-channel linear gains for a white-balance move, in Kelvin and tint.
 *
 * The ratio of the two white points in linear sRGB, then tint on the
 * green–magenta axis: Camera Raw's tint is positive toward magenta, which is a
 * *reduction* of green, so that is how it is applied.
 *
 * The triple is finally normalised to **unit luminance** rather than to green.
 * Normalising on green lets a large temperature move change the overall
 * brightness of the frame as a side effect, which then reads as an exposure
 * error on a screen whose whole purpose is judging exposure. Brightness belongs
 * to the exposure control and to nothing else.
 */
export function wbGains(fromKelvin: number, toKelvin: number, tintFrom: number, tintTo: number): [number, number, number] {
  const a = kelvinToLinearRgb(fromKelvin);
  const b = kelvinToLinearRgb(toKelvin);
  // A tint step is a much smaller move than a Kelvin step: ±150 covers roughly
  // the same visual distance as a couple of thousand Kelvin, hence the scale.
  const tint = (tintTo - tintFrom) * 0.0013;
  const gains: [number, number, number] = [a[0] / b[0], (a[1] / b[1]) * (1 - tint), a[2] / b[2]];
  const y = LUMA[0] * gains[0] + LUMA[1] * gains[1] + LUMA[2] * gains[2];
  const norm = y > 1e-6 ? 1 / y : 1;
  return [gains[0] * norm, gains[1] * norm, gains[2] * norm];
}

/** sRGB opto-electronic transfer function, linear [0,1] → encoded [0,1]. */
export function encode(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}
