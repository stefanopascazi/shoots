/**
 * The review shader's global tone math, on the CPU and on a histogram.
 *
 * Mirrors `review/glsl.ts` for the six basic tone controls only — Exposure,
 * Contrast, Highlights, Shadows, Whites, Blacks. Every one of them is a function
 * of a pixel's own log2 luminance and the frame's white, so a log-luma histogram
 * is enough to know where the whole frame lands: no pixels, no GPU. Local
 * controls (Texture, Clarity) and Dehaze are left out on purpose; they move
 * detail, not where the histogram sits.
 */
import { encode, LUMA, type LinearImage } from '../review/color.js';

/** Must match the shader constants in `review/glsl.ts`. */
const HIGHLIGHT_RANGE = 0.55;
const SHADOW_RANGE = 0.55;
const WHITE_STOPS = 1.1;
const BLACK_STOPS = 1.1;
const CONTRAST_RANGE = 0.45;
const HIGHLIGHT_PIVOT = -3.2;
const SHADOW_PIVOT = -4.6;
const GREY_BELOW_WHITE = -2.4739;
const BASE_CONTRAST = 0.3;

/** 1/16 stop over the sensor's 16 stops, as the review client bins it. */
export const BINS = 256;
const BIN_PER_STOP = 16;
const FLOOR_STOPS = -16;

/** Camera Raw names of the controls this module models, in vector order. */
export const TONE_KEYS = [
  'Exposure2012',
  'Contrast2012',
  'Highlights2012',
  'Shadows2012',
  'Whites2012',
  'Blacks2012',
] as const;
export type ToneKey = (typeof TONE_KEYS)[number];

/** Exposure in stops; the other five as the shader's −1..1. */
export interface Tone {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
}

export const NEUTRAL_TONE: Tone = { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 };

/** Camera Raw values (±100, Exposure in EV) to shader units. */
export function toneFromDevelop(develop: Record<string, number>): Tone {
  const s = (k: string): number => (develop[k] ?? 0) / 100;
  return {
    exposure: develop.Exposure2012 ?? 0,
    contrast: s('Contrast2012'),
    highlights: s('Highlights2012'),
    shadows: s('Shadows2012'),
    whites: s('Whites2012'),
    blacks: s('Blacks2012'),
  };
}

/** Shader units back to Camera Raw values. */
export function toneToDevelop(t: Tone): Record<ToneKey, number> {
  return {
    Exposure2012: t.exposure,
    Contrast2012: t.contrast * 100,
    Highlights2012: t.highlights * 100,
    Shadows2012: t.shadows * 100,
    Whites2012: t.whites * 100,
    Blacks2012: t.blacks * 100,
  };
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * One pixel's log2 luminance after the tone controls, as the shader shapes it.
 *
 * `l` and `anchor` are taken before exposure, the way the shader reads them.
 */
export function shapeLog(l: number, anchor: number, t: Tone): number {
  const ll = l + t.exposure;
  const white = anchor + t.exposure;
  const grey = white + GREY_BELOW_WHITE;
  let dl = 0;
  dl += t.highlights * HIGHLIGHT_RANGE * Math.min(Math.max(ll - (white + HIGHLIGHT_PIVOT), 0), 4);
  dl += t.shadows * SHADOW_RANGE * Math.min(Math.max(white + SHADOW_PIVOT - ll, 0), 4);
  dl += t.whites * WHITE_STOPS * smoothstep(white - 2.6, white + 0.2, ll);
  dl += t.blacks * BLACK_STOPS * (1 - smoothstep(white - 7.5, white - 3.2, ll));
  return grey + (ll + dl - grey) * (1 + t.contrast * CONTRAST_RANGE);
}

/** Log2 linear luminance to the encoded 0..1 value on screen, with the base S. */
export function displayValue(logY: number): number {
  const e = encode(Math.min(1, 2 ** logY));
  return e + (e * e * (3 - 2 * e) - e) * BASE_CONTRAST;
}

/** A frame reduced to what the tone controls can see. */
export interface LumaHistogram {
  /** Pixel fraction per 1/16-stop bin. */
  counts: Float64Array;
  /** The frame's white: log2 luma at the 99th percentile, before white balance. */
  anchor: number;
}

const binOf = (v: number): number => Math.min(BINS - 1, Math.max(0, Math.round((v - FLOOR_STOPS) * BIN_PER_STOP)));
const centreOf = (b: number): number => b / BIN_PER_STOP + FLOOR_STOPS;

/** Log-luma histogram of a scene-linear frame, with an optional white-balance gain. */
export function lumaHistogram(img: LinearImage, wb: readonly [number, number, number] = [1, 1, 1]): LumaHistogram {
  const n = img.width * img.height;
  const raw = new Float64Array(BINS);
  const counts = new Float64Array(BINS);
  for (let i = 0; i < n; i++) {
    const r = img.data[i * 3]! / 65535;
    const g = img.data[i * 3 + 1]! / 65535;
    const b = img.data[i * 3 + 2]! / 65535;
    raw[binOf(Math.log2(Math.max(LUMA[0] * r + LUMA[1] * g + LUMA[2] * b, 1e-7)))]! += 1;
    const y = LUMA[0] * r * wb[0] + LUMA[1] * g * wb[1] + LUMA[2] * b * wb[2];
    counts[binOf(Math.log2(Math.max(y, 1e-7)))]! += 1;
  }
  // The anchor rule is the client's: first bin where the cumulative count passes 99%.
  let seen = 0;
  let anchor = 0;
  for (let b = 0; b < BINS; b++) {
    seen += raw[b]!;
    if (seen >= n * 0.99) {
      anchor = b / BIN_PER_STOP + FLOOR_STOPS;
      break;
    }
  }
  for (let b = 0; b < BINS; b++) counts[b] = counts[b]! / Math.max(1, n);
  return { counts, anchor };
}

/** Where the look is read: display-value percentiles, shadows to highlights. */
export const LOOK_PERCENTILES = [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99] as const;

/**
 * The look a set of tone controls produces on a frame, as display percentiles.
 *
 * Sorted by output rather than by input bin, so a control setting that is not
 * monotone (a strong negative Contrast against a positive Shadows) still yields
 * true percentiles.
 */
export function lookOf(h: LumaHistogram, t: Tone): number[] {
  const pairs: [number, number][] = [];
  for (let b = 0; b < BINS; b++) {
    const w = h.counts[b]!;
    if (w > 0) pairs.push([displayValue(shapeLog(centreOf(b), h.anchor, t)), w]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const total = pairs.reduce((s, p) => s + p[1], 0);
  const out: number[] = [];
  let k = 0;
  let cum = 0;
  for (const p of LOOK_PERCENTILES) {
    while (k < pairs.length - 1 && cum + pairs[k]![1] < p * total) cum += pairs[k++]![1];
    out.push(pairs[k]?.[0] ?? 0);
  }
  return out;
}

/** Mean absolute look difference, in 8-bit code values. */
export function lookDistance(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return (s / a.length) * 255;
}

/**
 * A whole frame through the six tone controls, as 8-bit sRGB.
 *
 * The same shaping `lookOf` applies to histogram bins, applied per pixel as a
 * single gain on the three channels (luminance moves, hue and saturation do
 * not), then the display transform. For looking at what a set of controls does;
 * the local controls, saturation and curves are left out, as everywhere here.
 */
export function renderTone(img: LinearImage, wb: readonly [number, number, number], t: Tone, anchor: number): Uint8Array {
  const n = img.width * img.height;
  const out = new Uint8Array(n * 3);
  const shade = (v: number): number => {
    const e = encode(v);
    return Math.round(Math.min(1, Math.max(0, e + (e * e * (3 - 2 * e) - e) * BASE_CONTRAST)) * 255);
  };
  for (let i = 0; i < n; i++) {
    const r = (img.data[i * 3]! / 65535) * wb[0];
    const g = (img.data[i * 3 + 1]! / 65535) * wb[1];
    const b = (img.data[i * 3 + 2]! / 65535) * wb[2];
    const l = Math.log2(Math.max(LUMA[0] * r + LUMA[1] * g + LUMA[2] * b, 1e-7));
    const gain = 2 ** (shapeLog(l, anchor, t) - l);
    out[i * 3] = shade(r * gain);
    out[i * 3 + 1] = shade(g * gain);
    out[i * 3 + 2] = shade(b * gain);
  }
  return out;
}
