/**
 * The built-in rating profiles and the star mapping they drive.
 *
 * A profile is two decisions in one object — *what matters* (the merit weights)
 * and *how strict* (the cut-offs and the focus gate) — and the star mapping is
 * where the second one bites. Focus never adds a star; it only ever takes them
 * away, and that asymmetry is the property tested hardest here.
 */
import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_PROFILES,
  DEFAULT_PROFILE_NAME,
  getProfile,
  PROFILE_NAMES,
  type RatingProfile,
} from '../src/profiles.js';
import { toStarRating, type QualityAssessment } from '../src/QualityModel.js';

const assess = (over: Partial<QualityAssessment> = {}): QualityAssessment => ({
  focus: 0.9,
  aesthetic: 0.5,
  aspects: [],
  keywords: [],
  ...over,
});

const STREET = getProfile('street')!;

describe('the built-in registry', () => {
  test('lists every profile exactly once, and the map agrees with it', () => {
    expect(new Set(PROFILE_NAMES).size).toBe(PROFILE_NAMES.length);
    expect([...BUILTIN_PROFILES.keys()].sort()).toEqual([...PROFILE_NAMES].sort());
  });

  test('resolves each name to a profile that knows its own name', () => {
    for (const name of PROFILE_NAMES) expect(getProfile(name)!.name).toBe(name);
  });

  test('is undefined for an unknown name rather than falling back silently', () => {
    expect(getProfile('nope')).toBeUndefined();
    expect(getProfile('')).toBeUndefined();
  });

  test('defaults to the one profile calibrated against real judged photographs', () => {
    expect(DEFAULT_PROFILE_NAME).toBe('street');
    expect(getProfile(DEFAULT_PROFILE_NAME)!.calibrated).toBe(true);
  });

  test('marks the uncalibrated priors honestly', () => {
    for (const name of PROFILE_NAMES) {
      if (name !== 'street') expect(getProfile(name)!.calibrated).toBe(false);
    }
  });
});

describe('every built-in profile', () => {
  const each = (assertion: (p: RatingProfile) => void): void => {
    for (const name of PROFILE_NAMES) assertion(getProfile(name)!);
  };

  test('orders its star cut-offs descending, so the first clear wins', () => {
    each((p) => {
      for (let i = 1; i < p.aestheticStars.length; i++) {
        expect(p.aestheticStars[i]!.min).toBeLessThan(p.aestheticStars[i - 1]!.min);
        expect(p.aestheticStars[i]!.stars).toBeLessThan(p.aestheticStars[i - 1]!.stars);
      }
    });
  });

  test('offers all five stars', () => {
    each((p) => expect(p.aestheticStars.map((t) => t.stars)).toEqual([5, 4, 3, 2, 1]));
  });

  test('gates focus in the right order: reject below soft', () => {
    each((p) => {
      expect(p.focusReject).toBeGreaterThan(0);
      expect(p.focusReject).toBeLessThan(p.focusSoft);
      expect(p.focusSoft).toBeLessThanOrEqual(1);
    });
  });

  test('caps soft frames below the top', () => {
    each((p) => {
      expect(p.focusSoftCap).toBeGreaterThanOrEqual(0);
      expect(p.focusSoftCap).toBeLessThan(5);
    });
  });

  test('weights only positive aspects, and at least one of them', () => {
    each((p) => {
      if (p.type !== 'aspect-weights') return;
      const weights = Object.values(p.meritWeights);
      expect(weights.length).toBeGreaterThan(0);
      expect(weights.every((w) => w > 0)).toBe(true);
    });
  });

  test('carries a one-line description for the help text', () => {
    each((p) => expect(p.description.length).toBeGreaterThan(0));
  });
});

describe('the calibrated street profile', () => {
  // The documented character of this profile: craft is table stakes for a pro,
  // so nailing exposure and sharpness earns nothing on its own.
  test('pays nothing for technical competence', () => {
    const street = STREET as Extract<RatingProfile, { type: 'aspect-weights' }>;
    for (const aspect of ['exposure', 'sharpness', 'composition']) {
      expect(street.meritWeights[aspect]).toBeUndefined();
    }
    expect(street.meritWeights.storytelling).toBeGreaterThan(0);
  });

  test('sets a harder bar than the forgiving generic profile', () => {
    const generic = getProfile('generic')!;
    expect(STREET.aestheticStars[0]!.min).toBeGreaterThan(generic.aestheticStars[4]!.min);
    expect(STREET.aestheticStars[4]!.min).toBeGreaterThan(generic.aestheticStars[4]!.min);
  });
});

describe('toStarRating', () => {
  test('rejects outright below the focus floor, whatever the merit', () => {
    expect(toStarRating(assess({ focus: 0.1, aesthetic: 0.99 }), STREET)).toBe(0);
  });

  test('awards the first cut-off the merit clears', () => {
    expect(toStarRating(assess({ aesthetic: 0.63 }), STREET)).toBe(5);
    expect(toStarRating(assess({ aesthetic: 0.62 }), STREET)).toBe(4);
    expect(toStarRating(assess({ aesthetic: 0.55 }), STREET)).toBe(3);
    expect(toStarRating(assess({ aesthetic: 0.5 }), STREET)).toBe(1);
  });

  test('gives zero below the lowest cut-off — 0 is a verdict, not a missing value', () => {
    expect(toStarRating(assess({ aesthetic: 0.49 }), STREET)).toBe(0);
    expect(toStarRating(assess({ aesthetic: 0 }), STREET)).toBe(0);
  });

  test('caps a soft frame instead of rejecting it', () => {
    const soft = assess({ focus: 0.4, aesthetic: 0.99 }); // between reject and soft
    expect(toStarRating(soft, STREET)).toBe(STREET.focusSoftCap);
  });

  test('leaves a soft frame alone when it was already below the cap', () => {
    expect(toStarRating(assess({ focus: 0.4, aesthetic: 0.3 }), STREET)).toBe(0);
  });

  test('focus never adds a star', () => {
    const merit = 0.56; // worth 3 on street
    const sharp = toStarRating(assess({ focus: 1, aesthetic: merit }), STREET);
    const acceptable = toStarRating(assess({ focus: 0.6, aesthetic: merit }), STREET);
    expect(sharp).toBe(acceptable);
  });

  test('is monotone in merit for every built-in profile', () => {
    for (const name of PROFILE_NAMES) {
      const profile = getProfile(name)!;
      let previous = -1;
      for (let merit = 0; merit <= 1.0001; merit += 0.02) {
        const stars = toStarRating(assess({ aesthetic: merit }), profile);
        expect(stars).toBeGreaterThanOrEqual(previous);
        previous = stars;
      }
    }
  });

  test('treats the focus thresholds as inclusive-below, exclusive-at', () => {
    const atReject = assess({ focus: STREET.focusReject, aesthetic: 0.99 });
    expect(toStarRating(atReject, STREET)).toBeGreaterThan(0);

    const atSoft = assess({ focus: STREET.focusSoft, aesthetic: 0.99 });
    expect(toStarRating(atSoft, STREET)).toBe(5);
  });
});
