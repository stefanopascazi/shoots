/**
 * An approximation of Camera Raw's basic panel, good enough to judge *intensity*.
 *
 * The review screen exists to answer one question — "is that too much or too
 * little?" — and that judgement only needs the rendering to be **monotone** in
 * each slider, not identical to Lightroom's. So this is deliberately an
 * approximation, and the ways it differs are worth stating rather than
 * discovering:
 *
 * - **Exposure and white balance are exact.** Both are per-channel
 *   multiplications in scene-linear light, which is precisely what Camera Raw
 *   does with them.
 * - **The tone controls are approximate.** Highlights, Shadows, Whites, Blacks,
 *   Contrast and the point curve are folded into one monotone curve over the
 *   encoded value, applied per channel. Camera Raw weights them on luminance and
 *   the shapes are its own; the direction and the ordering match, the numbers do
 *   not.
 * - **Clarity and Texture are not applied at all.** They are *spatial* — local
 *   contrast over a neighbourhood — and cannot be expressed as a curve. Showing
 *   a wrong version would be worse than showing none.
 *
 * Everything except saturation is therefore a single per-channel lookup table,
 * which is what makes a slider move cost ~20ms on a 900px preview instead of a
 * re-decode.
 */

/** Scene-linear RGB, 16-bit, as the RAW developer produced it. */
export interface LinearImage {
  data: Uint16Array;
  width: number;
  height: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** sRGB opto-electronic transfer function, linear [0,1] → encoded [0,1]. */
export function encode(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

/**
 * Per-channel linear gains for a white-balance move, in Kelvin and tint.
 *
 * Planckian locus via Kim et al.'s cubic approximation, then the ratio of the
 * two white points in linear sRGB, normalised on green so the move carries no
 * overall brightness — that belongs to exposure.
 */
export function wbGains(fromKelvin: number, toKelvin: number, tint: number): [number, number, number] {
  const xy = (kelvin: number): [number, number] => {
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
  };
  const rgb = (kelvin: number): [number, number, number] => {
    const [x, y] = xy(kelvin);
    const X = x / y;
    const Z = (1 - x - y) / y;
    return [
      3.2404542 * X - 1.5371385 - 0.4985314 * Z,
      -0.969266 * X + 1.8760108 + 0.041556 * Z,
      0.0556434 * X - 0.2040259 + 1.0572252 * Z,
    ];
  };
  const a = rgb(fromKelvin);
  const b = rgb(toKelvin);
  const raw: [number, number, number] = [a[0] / b[0], a[1] / b[1], a[2] / b[2]];
  const g = raw[1] || 1;
  return [raw[0] / g, 1 - tint * 0.0025, raw[2] / g];
}

/** Smooth 0→1 ramp, so a region control has no edge where it stops acting. */
const smooth = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

/** Piecewise-linear sample of the point curve at 0..255 inputs. */
function curveAt(knots: readonly [number, number][], x: number): number {
  if (knots.length === 0) return x;
  if (x <= knots[0]![0]) return knots[0]![1];
  for (let i = 1; i < knots.length; i++) {
    const [x1, y1] = knots[i]!;
    if (x <= x1) {
      const [x0, y0] = knots[i - 1]!;
      const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      return y0 + (y1 - y0) * t;
    }
  }
  return knots[knots.length - 1]![1];
}

export interface ToneSettings {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  /**
   * Dehaze, folded in as the contrast-and-black-point move it mostly is.
   *
   * Camera Raw's is a physical haze model over local depth; this is a global
   * approximation of its two visible consequences — the histogram spreads and
   * the bottom end drops. Directionally right, numerically not, which is the
   * same bargain the region controls make. It is here rather than omitted
   * because Dehaze carries the strongest anchor in the model, and a control the
   * preview cannot show is a control nobody can calibrate.
   */
  dehaze: number;
  /** `[input, output]` pairs at 0..255, already sampled from the profile. */
  curve: [number, number][];
}

/**
 * One per-channel table: scene-linear 16-bit in, 8-bit sRGB out.
 *
 * Everything monotone folds into here — the exposure gain, that channel's white
 * balance gain, the four region controls, contrast and the point curve — so the
 * pixel loop is a lookup and nothing else.
 */
export function buildLut(t: ToneSettings, channelGain: number): Uint8Array {
  const lut = new Uint8Array(65536);
  const exposure = 2 ** t.exposure;
  // Region strengths, scaled to Camera Raw's ±100 range.
  const hi = t.highlights / 100;
  const sh = t.shadows / 100;
  const wh = t.whites / 100;
  const dehaze = t.dehaze / 100;
  const bl = t.blacks / 100 - dehaze * 0.35;
  const contrast = t.contrast / 100 + dehaze * 0.5;
  for (let i = 0; i < 65536; i++) {
    let v = encode(clamp01((i / 65535) * exposure * channelGain));

    // Whites and blacks move the endpoints; highlights and shadows bend the
    // regions inside them. Each is weighted by a smooth mask so no control has a
    // visible boundary where it stops acting.
    // Every one of these follows Camera Raw's sign: positive brightens the
    // region it acts on, negative darkens it. Highlights and Blacks had it
    // backwards, which made highlight recovery brighten the very areas it exists
    // to rescue — the slider ran the wrong way and hard.
    // The coefficients are deliberately gentle. At 0.35 a full-strength
    // Highlights move swallowed a third of the encoded range and tore the
    // picture apart — far more than Camera Raw does at −100, which makes the
    // preview useless for judging "how much" precisely when it matters most.
    v += wh * 0.18 * smooth((v - 0.5) / 0.5);
    v += bl * 0.18 * smooth((0.5 - v) / 0.5);
    v += hi * 0.22 * smooth((v - 0.35) / 0.65);
    v += sh * 0.22 * smooth((0.65 - v) / 0.65);

    // Contrast as an S-curve about middle grey.
    if (contrast !== 0) v += contrast * 0.28 * Math.sin(2 * Math.PI * clamp01(v)) * -1;

    if (t.curve.length > 1) v = curveAt(t.curve, clamp01(v) * 255) / 255;
    lut[i] = Math.round(clamp01(v) * 255);
  }
  return lut;
}

/**
 * Apply three tables and a saturation move to a linear image.
 *
 * Saturation cannot live in the tables — it is a cross-channel operation — so it
 * runs in the loop. Vibrance is the same move weighted toward the *less*
 * saturated pixels, which is what makes it protect skin where saturation does not.
 */
export function render(
  image: LinearImage,
  luts: readonly [Uint8Array, Uint8Array, Uint8Array],
  saturation: number,
  vibrance: number,
): Uint8Array {
  const n = image.width * image.height;
  const out = new Uint8Array(n * 3);
  const sat = saturation / 100;
  const vib = vibrance / 100;
  const flat = sat === 0 && vib === 0;
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    const r = luts[0][image.data[j]!]!;
    const g = luts[1][image.data[j + 1]!]!;
    const b = luts[2][image.data[j + 2]!]!;
    if (flat) {
      out[j] = r;
      out[j + 1] = g;
      out[j + 2] = b;
      continue;
    }
    const grey = 0.299 * r + 0.587 * g + 0.114 * b;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const current = max > 0 ? (max - min) / max : 0;
    // Vibrance leans on the pixels that have little colour to begin with.
    const scale = 1 + sat + vib * (1 - current);
    out[j] = Math.round(clamp01((grey + (r - grey) * scale) / 255) * 255);
    out[j + 1] = Math.round(clamp01((grey + (g - grey) * scale) / 255) * 255);
    out[j + 2] = Math.round(clamp01((grey + (b - grey) * scale) / 255) * 255);
  }
  return out;
}
