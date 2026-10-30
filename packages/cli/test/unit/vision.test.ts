import { describe, expect, test } from 'bun:test';
import { MASK_GRID, maskShare, packMask, readRecord, unpackMask } from '../../src/vision/record.js';
import { visionProducer, PRODUCER_PREFIXES } from '../../src/cache/producers.js';

describe('vision masks', () => {
  test('pack and unpack round-trip', () => {
    const m = new Uint8Array(MASK_GRID * MASK_GRID).map((_, i) => (i % 3 === 0 ? 1 : 0));
    expect(unpackMask(packMask(m))).toEqual(m);
  });

  test('share counts the covered cells', () => {
    const m = new Uint8Array(MASK_GRID * MASK_GRID);
    m.fill(1, 0, m.length / 4);
    expect(maskShare(packMask(m))).toBeCloseTo(0.25, 9);
  });
});

describe('vision records', () => {
  test('a well-formed record is read back, a damaged one refused', () => {
    expect(readRecord({ caption: 'a beach', objects: [], regions: {} })).toEqual({ caption: 'a beach', objects: [], regions: {} });
    expect(readRecord({ caption: 3, objects: [], regions: {} })).toBeNull();
    expect(readRecord(null)).toBeNull();
  });

  test('the producer key is versioned and prunable', () => {
    expect(visionProducer('base-ft-fp32-1')).toBe('vision@1:base-ft-fp32-1');
    expect(PRODUCER_PREFIXES).toContain('vision@');
  });
});

import { presentRegions } from '../../src/vision/analyze.js';

describe('presentRegions', () => {
  test('sky from the caption, a person from the objects', () => {
    expect(presentRegions('A man on a beach under a cloudy sky.', ['person', 'human face'])).toEqual(['sky', 'subject']);
  });

  test('an indoor portrait has no sky; a field of flowers has no subject', () => {
    expect(presentRegions('A man is looking at the camera. The walls are white.', ['person'])).toEqual(['subject']);
    expect(presentRegions('A bunch of flowers in a field.', ['flower', 'plant'])).toEqual([]);
  });
});
