import { describe, expect, test } from 'bun:test';
import { contrastRatio, parseHex, relativeLuminance } from '../src/color/contrast.js';

describe('contrast', () => {
  test('parses short and long hex', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255]);
    expect(parseHex('f0b429')).toEqual([240, 180, 41]);
  });

  test('rejects anything that is not hex', () => {
    expect(() => parseHex('rgb(0 0 0)')).toThrow();
  });

  test('black on white is 21:1 and symmetric', () => {
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 5);
  });

  test('luminance spans 0..1', () => {
    expect(relativeLuminance([0, 0, 0])).toBe(0);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 10);
  });
});
