/**
 * The colorimetry the preview and the shader share.
 *
 * This file claims to be exact physics rather than an approximation of Camera
 * Raw, so it is tested as physics: a null move is the identity, warming pushes
 * red up and blue down, and — the one that was a real bug class — a temperature
 * move must not change the brightness of the frame, because a screen for judging
 * exposure cannot have the white balance quietly moving the exposure.
 */
import { describe, expect, test } from 'bun:test';
import { encode, LUMA, wbGains } from '../../src/develop/review/color.js';

const luminance = (g: readonly [number, number, number]): number =>
  LUMA[0] * g[0] + LUMA[1] * g[1] + LUMA[2] * g[2];

describe('LUMA', () => {
  test('is the Rec.709 triple and sums to one', () => {
    expect([...LUMA]).toEqual([0.2126, 0.7152, 0.0722]);
    expect(LUMA[0] + LUMA[1] + LUMA[2]).toBeCloseTo(1, 12);
  });
});

describe('wbGains', () => {
  test('a null move is the identity', () => {
    const gains = wbGains(5500, 5500, 0, 0);
    for (const g of gains) expect(g).toBeCloseTo(1, 9);
  });

  // The bug this normalisation exists to prevent: a big Kelvin move reading as
  // an exposure error on the very screen meant for judging exposure.
  test('never changes the luminance of the frame, at any temperature', () => {
    for (const to of [2000, 3200, 5500, 8000, 20000, 40000]) {
      expect(luminance(wbGains(5500, to, 0, 0))).toBeCloseTo(1, 9);
    }
  });

  test('warming the render lifts red and lowers blue', () => {
    // Choosing a lower Kelvin than as-shot cools the pixels; a higher one warms.
    const warmer = wbGains(5500, 8000, 0, 0);
    expect(warmer[0]!).toBeGreaterThan(1);
    expect(warmer[2]!).toBeLessThan(1);
  });

  test('cooling is the mirror image', () => {
    const cooler = wbGains(5500, 3200, 0, 0);
    expect(cooler[0]!).toBeLessThan(1);
    expect(cooler[2]!).toBeGreaterThan(1);
  });

  test('is monotone in temperature', () => {
    const red = [3000, 4000, 5500, 7000, 9000].map((k) => wbGains(5500, k, 0, 0)[0]!);
    for (let i = 1; i < red.length; i++) expect(red[i]!).toBeGreaterThan(red[i - 1]!);
  });

  test('a positive tint step reduces green, as Camera Raw defines it', () => {
    const magenta = wbGains(5500, 5500, 0, 100);
    const green = wbGains(5500, 5500, 0, -100);
    expect(magenta[1]!).toBeLessThan(green[1]!);
  });

  test('a tint move keeps the luminance too', () => {
    expect(luminance(wbGains(5500, 5500, 0, 150))).toBeCloseTo(1, 9);
    expect(luminance(wbGains(5500, 7000, -50, 50))).toBeCloseTo(1, 9);
  });

  /**
   * Every gain is positive across the whole domain this can be reached with.
   *
   * The domain is 2000..50000 K on both sides, and it is bounded three times
   * over on the way in: `decodeDelta`, `predictAnchor` and `applyOffset` all
   * clamp a predicted Temperature to the schema's own `absMin`/`absMax`, so the
   * chosen side cannot leave it, and the as-shot side comes from a camera or
   * from `crs:Temperature`, whose floor is the same 2000.
   *
   * Worth stating because the sign is not free below that floor: the Planckian
   * locus leaves the sRGB gamut around 1904 K, where the blue coefficient of the
   * white point turns negative and the ratio taken here would invert the channel.
   * The bound is what makes that unreachable, not a guard inside this function —
   * so if a caller ever widens the range, this test is the one that fails.
   */
  test('gives a positive gain on every channel across the reachable domain', () => {
    let checked = 0;
    for (let asShot = 2000; asShot <= 50000; asShot += 250) {
      for (let chosen = 2000; chosen <= 50000; chosen += 250) {
        for (const [tintFrom, tintTo] of [[0, 0], [-150, 150], [150, -150]] as const) {
          const gains = wbGains(asShot, chosen, tintFrom, tintTo);
          expect(gains.every(Number.isFinite)).toBe(true);
          expect(gains.every((g) => g > 0)).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100000);
  });

  test('stays finite even outside the domain, so a bad EXIF read cannot crash a preview', () => {
    for (const [from, to] of [[1, 5500], [5500, 1e9], [0, 0]] as const) {
      expect(wbGains(from, to, 0, 0).every(Number.isFinite)).toBe(true);
    }
  });

  test('saturates above the top of the Planckian approximation', () => {
    // 25000 K is where Kim et al. stops being valid, so everything above it is
    // the same white point rather than an extrapolation.
    expect(wbGains(5500, 50000, 0, 0)).toEqual(wbGains(5500, 25000, 0, 0));
  });

  test('a move and its reverse cancel to within the luminance renormalisation', () => {
    const there = wbGains(5500, 6500, 0, 0);
    const back = wbGains(6500, 5500, 0, 0);
    // Not exactly 1: each direction is renormalised to unit luminance on its own,
    // and that normalisation does not compose. Close enough that no visible
    // brightness survives the round trip.
    for (let c = 0; c < 3; c++) expect(there[c]! * back[c]!).toBeCloseTo(1, 1);
  });
});

describe('encode', () => {
  test('pins the ends of the range', () => {
    expect(encode(0)).toBe(0);
    expect(encode(1)).toBe(1);
  });

  test('clamps outside it rather than extrapolating', () => {
    expect(encode(-0.5)).toBe(0);
    expect(encode(2)).toBe(1);
  });

  test('is the linear segment near black', () => {
    expect(encode(0.001)).toBeCloseTo(0.001 * 12.92, 12);
  });

  test('is the power segment above the knee, continuous across it', () => {
    const knee = 0.0031308;
    expect(encode(knee)).toBeCloseTo(knee * 12.92, 9);
    expect(encode(knee + 1e-9)).toBeCloseTo(encode(knee), 6);
  });

  test('maps mid-linear to the familiar sRGB mid-tone', () => {
    expect(encode(0.5)).toBeCloseTo(0.7354, 3);
    expect(encode(0.2140)).toBeCloseTo(0.5, 2);
  });

  test('is monotone increasing', () => {
    let previous = -1;
    for (let v = 0; v <= 1; v += 0.01) {
      const e = encode(v);
      expect(e).toBeGreaterThanOrEqual(previous);
      previous = e;
    }
  });
});
