import { describe, expect, test } from 'bun:test';
import { createTokenizer } from '../src/florence/tokenizer.js';
import { parseBoxes, parsePolygons, parseText, rasterisePolygons } from '../src/florence/parse.js';
import { bannedNext, preprocess } from '../src/florence/model.js';

/** A toy byte-level BPE: 'h','i','Ġ' plus merges that build "hi" and "Ġhi". */
const toy = createTokenizer({
  model: {
    vocab: { h: 10, i: 11, 'Ġ': 12, hi: 13, 'Ġhi': 14, '<s>': 0, '</s>': 2 },
    merges: ['h i', 'Ġ hi'],
  },
  added_tokens: [
    { id: 0, content: '<s>' },
    { id: 2, content: '</s>' },
    { id: 500, content: '<loc_7>' },
  ],
});

describe('tokenizer', () => {
  test('frames with <s>…</s> and applies merges by rank', () => {
    expect(toy.encode('hi hi')).toEqual([0, 13, 14, 2]);
  });

  test('decodes byte tokens and keeps added tokens verbatim', () => {
    expect(toy.decode([0, 13, 14, 500, 2])).toBe('<s>hi hi<loc_7></s>');
  });

  test('refuses a token it does not have', () => {
    expect(() => toy.encode('z')).toThrow(/not in the vocabulary/);
  });
});

describe('parse', () => {
  test('text answers lose their special tokens', () => {
    expect(parseText('</s><s>A dog  on a\nbeach.</s><pad>')).toBe('A dog on a beach.');
  });

  test('boxes take bin centres, and an omitted label repeats the previous one', () => {
    const b = parseBoxes('<s>person<loc_0><loc_0><loc_499><loc_999><loc_500><loc_0><loc_999><loc_999>sky<loc_0><loc_0><loc_999><loc_100></s>', 1000, 2000);
    expect(b.labels).toEqual(['person', 'person', 'sky']);
    expect(b.boxes[0]).toEqual([0.5, 1, 499.5, 1999]);
  });

  test('polygons split on <sep> and drop degenerate parts', () => {
    const p = parsePolygons('<loc_0><loc_0><loc_999><loc_0><loc_999><loc_999><sep><loc_1><loc_1></s>', 1000, 1000);
    expect(p).toHaveLength(1);
    expect(p[0]).toHaveLength(6);
  });

  test('rasterising a triangle fills about half the square', () => {
    const m = rasterisePolygons([[0, 0, 100, 0, 100, 100]], 100, 100, 40, 40);
    const share = m.reduce((a, b) => a + b, 0) / m.length;
    expect(share).toBeGreaterThan(0.45);
    expect(share).toBeLessThan(0.55);
  });
});

describe('generation helpers', () => {
  test('bannedNext forbids completing a repeated 3-gram', () => {
    expect([...bannedNext([5, 6, 7, 5, 6], 3)]).toEqual([7]);
    expect(bannedNext([5, 6], 3).size).toBe(0);
  });

  test('preprocess yields normalised 3×768×768 planes', () => {
    const rgb = new Uint8Array(4 * 2 * 3).fill(255);
    const out = preprocess(rgb, 4, 2);
    expect(out.length).toBe(3 * 768 * 768);
    // White, normalised with the red channel's ImageNet mean and std.
    expect(out[0]).toBeCloseTo((1 - 0.485) / 0.229, 5);
  });
});
