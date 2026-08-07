/**
 * Scaling a fitted profile by what the reviewer chose.
 *
 * The load-bearing decision is that intensities are keyed **per treatment**: one
 * multiplier across both branches would mean a judgement made looking at colour
 * photographs silently rescaling the black-and-white anchors, which is the branch
 * the model predicts worst and the one that most needs a human to look.
 *
 * `withIntensities` also has to be exception-safe — a half-finished slider drag
 * must never leave a scaled anchor behind in the object that gets written out.
 */
import { describe, expect, test } from 'bun:test';
import {
  activeFamilies,
  applyIntensities,
  describeIntensities,
  intensityKey,
  splitKey,
  withIntensities,
} from '../../src/develop/review/intensities.js';
import type { AnchorModel } from '../../src/develop/train/anchor.js';
import type { DevelopProfile } from '../../src/develop/types.js';

const anchor = (over: Partial<AnchorModel> = {}): AnchorModel => ({
  feature: 'lumaMean',
  index: 0,
  xbar: 0.5,
  ybar: 0,
  gain: 2,
  tailSkill: 0.1,
  skill: 0.05,
  ...over,
});

/** A profile carrying nothing but the anchors these helpers touch. */
const profile = (): DevelopProfile =>
  ({
    branches: {
      color: {
        anchors: {
          Exposure2012: anchor({ gain: 2, gainBelow: 0.5 }),
          Contrast2012: anchor({ gain: 10 }),
        },
      },
      bw: {
        anchors: { Exposure2012: anchor({ gain: 4 }) },
      },
    },
  }) as unknown as DevelopProfile;

describe('intensityKey / splitKey', () => {
  test('round-trip', () => {
    expect(splitKey(intensityKey('bw', 'Exposure2012'))).toEqual({
      treatment: 'bw',
      family: 'Exposure2012',
    });
  });

  test('reads a legacy key with no treatment as colour', () => {
    expect(splitKey('Exposure2012')).toEqual({ treatment: 'color', family: 'Exposure2012' });
  });

  test('splits on the first colon only', () => {
    expect(splitKey('color:a:b')).toEqual({ treatment: 'color', family: 'a:b' });
  });
});

describe('applyIntensities', () => {
  test('scales the gain of the named control', () => {
    const p = profile();
    applyIntensities(p, { 'color:Exposure2012': 2 });
    expect(p.branches.color!.anchors!.Exposure2012!.gain).toBe(4);
  });

  test('scales the below-the-dead-zone gain with it', () => {
    const p = profile();
    applyIntensities(p, { 'color:Exposure2012': 2 });
    expect(p.branches.color!.anchors!.Exposure2012!.gainBelow).toBe(1);
  });

  // The whole reason the key carries a treatment.
  test('leaves the other branch alone', () => {
    const p = profile();
    applyIntensities(p, { 'color:Exposure2012': 3 });
    expect(p.branches.bw!.anchors!.Exposure2012!.gain).toBe(4);
  });

  test('leaves the other controls of the same branch alone', () => {
    const p = profile();
    applyIntensities(p, { 'color:Exposure2012': 3 });
    expect(p.branches.color!.anchors!.Contrast2012!.gain).toBe(10);
  });

  test('a multiplier of one is a no-op', () => {
    const p = profile();
    applyIntensities(p, { 'color:Exposure2012': 1 });
    expect(p.branches.color!.anchors!.Exposure2012!.gain).toBe(2);
  });

  test('scales to nothing at zero, which is "turn this control off"', () => {
    const p = profile();
    applyIntensities(p, { 'color:Contrast2012': 0 });
    expect(p.branches.color!.anchors!.Contrast2012!.gain).toBe(0);
  });

  test('ignores a key naming a control this profile has no anchor for', () => {
    const p = profile();
    applyIntensities(p, { 'color:Dehaze': 5, 'bw:Contrast2012': 5 });
    expect(p.branches.color!.anchors!.Exposure2012!.gain).toBe(2);
    expect(p.branches.bw!.anchors!.Exposure2012!.gain).toBe(4);
  });
});

describe('withIntensities', () => {
  test('runs the callback against the scaled profile', () => {
    const p = profile();
    const seen = withIntensities(p, { 'color:Exposure2012': 2.5 }, () =>
      p.branches.color!.anchors!.Exposure2012!.gain,
    );
    expect(seen).toBe(5);
  });

  test('restores every gain afterwards', () => {
    const p = profile();
    withIntensities(p, { 'color:Exposure2012': 2.5, 'bw:Exposure2012': 0.5 }, () => undefined);
    expect(p.branches.color!.anchors!.Exposure2012!.gain).toBe(2);
    expect(p.branches.color!.anchors!.Exposure2012!.gainBelow).toBe(0.5);
    expect(p.branches.bw!.anchors!.Exposure2012!.gain).toBe(4);
  });

  // A drag that throws must not leave a scaled anchor in the object that is
  // eventually written out.
  test('restores even when the callback throws', () => {
    const p = profile();
    expect(() =>
      withIntensities(p, { 'color:Exposure2012': 9 }, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(p.branches.color!.anchors!.Exposure2012!.gain).toBe(2);
  });

  test('returns whatever the callback returned', () => {
    expect(withIntensities(profile(), {}, () => 'value')).toBe('value');
  });

  test('nests without losing the outer restore', () => {
    const p = profile();
    withIntensities(p, { 'color:Exposure2012': 2 }, () => {
      withIntensities(p, { 'color:Exposure2012': 3 }, () => {
        expect(p.branches.color!.anchors!.Exposure2012!.gain).toBe(12);
      });
      expect(p.branches.color!.anchors!.Exposure2012!.gain).toBe(4);
    });
    expect(p.branches.color!.anchors!.Exposure2012!.gain).toBe(2);
  });
});

describe('activeFamilies', () => {
  test('offers one control per anchored parameter per branch, starting at one', () => {
    expect(activeFamilies(profile())).toEqual({
      'color:Exposure2012': 1,
      'color:Contrast2012': 1,
      'bw:Exposure2012': 1,
    });
  });

  test('is empty for a profile with no anchors at all', () => {
    const bare = { branches: { color: { anchors: {} } } } as unknown as DevelopProfile;
    expect(activeFamilies(bare)).toEqual({});
  });
});

describe('describeIntensities', () => {
  test('names the treatment, because the same number means different things per branch', () => {
    expect(describeIntensities({ 'color:Exposure2012': 2.2 })).toBe('Exposure2012 2.20× (color)');
    expect(describeIntensities({ 'bw:Exposure2012': 0.5 })).toBe('Exposure2012 0.50× (b&w)');
  });

  test('joins several controls in one line', () => {
    expect(describeIntensities({ 'color:Exposure2012': 1, 'color:Contrast2012': 2 })).toBe(
      'Exposure2012 1.00× (color), Contrast2012 2.00× (color)',
    );
  });

  test('is empty when nothing was chosen', () => {
    expect(describeIntensities({})).toBe('');
  });
});
