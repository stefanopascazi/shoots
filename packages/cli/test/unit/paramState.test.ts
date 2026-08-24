/**
 * What a parameter does at prediction time, and how a reader is told.
 *
 * The three states are the profile's contract, so the tests below pin the two
 * places it is easy to get wrong: `leveled` must not be reported as `predicted`
 * (the model knows where a shoot sits but cannot tell its frames apart, and
 * saying otherwise is a claim it does not support), and an anchored slider must
 * not be reported as a constant (the anchor replaces both heads, so their gates
 * describe machinery that does not run for it).
 */
import { describe, expect, test } from 'bun:test';
import {
  countStates,
  describeGateReason,
  gateReasonFor,
  PARAM_STATES,
  paramState,
  stateMap,
  summariseStates,
} from '../../src/develop/develop/paramState.js';

const row = (key: string, gated: boolean, frameGated: boolean, state?: 'predicted' | 'leveled' | 'constant') => ({
  key,
  gated,
  frame: { gated: frameGated },
  ...(state ? { state } : {}),
});

describe('paramState', () => {
  test('both heads live means the value follows the photograph', () => {
    expect(paramState(false, false)).toBe('predicted');
  });

  test('a gated frame head means one value for the whole shoot', () => {
    expect(paramState(false, true)).toBe('leveled');
  });

  test('both heads gated means the photographer own constant', () => {
    expect(paramState(true, true)).toBe('constant');
  });

  // A live frame head with a gated level one still moves per photograph — the
  // shoot sits at the catalog constant and the frame departs from it.
  test('a gated level head alone still predicts per frame', () => {
    expect(paramState(true, false)).toBe('predicted');
  });

  test('lists the states in reporting order', () => {
    expect(PARAM_STATES).toEqual(['predicted', 'leveled', 'constant']);
  });
});

describe('gateReasonFor', () => {
  test('a target that never moved is degenerate, whatever the skill did', () => {
    expect(gateReasonFor(true, false)).toBe('degenerate');
    expect(gateReasonFor(true, true)).toBe('degenerate');
  });

  test('negative skill is its own reason, not lumped in with a low one', () => {
    expect(gateReasonFor(false, true)).toBe('negative-skill');
    expect(gateReasonFor(false, false)).toBe('low-skill');
  });

  test('every reason has a line a photographer can act on', () => {
    expect(describeGateReason('degenerate')).toMatch(/never varied/);
    expect(describeGateReason('negative-skill')).toMatch(/worse than your own average/);
    expect(describeGateReason('low-skill')).toMatch(/measurement noise/);
  });
});

describe('stateMap', () => {
  test('reads the state a profile records', () => {
    const branch = {
      perParam: [
        row('Exposure2012', false, false, 'predicted'),
        row('Contrast2012', false, true, 'leveled'),
        row('RedHue', true, true, 'constant'),
      ],
    };
    expect(stateMap(branch)).toEqual({
      Exposure2012: 'predicted',
      Contrast2012: 'leveled',
      RedHue: 'constant',
    });
  });

  // Dehaze reads −0.5% in the colour table and ships at 0.258 tail skill: its
  // heads are gated and its anchor is what runs.
  test('an anchored slider is predicted however its heads were gated', () => {
    const branch = {
      perParam: [row('Dehaze', true, true, 'constant'), row('RedHue', true, true, 'constant')],
      anchors: { Dehaze: { gain: 1 } },
    };
    expect(stateMap(branch)).toEqual({ Dehaze: 'predicted', RedHue: 'constant' });
  });

  test('reconstructs the state for a profile written before it was recorded', () => {
    const branch = {
      perParam: [row('Exposure2012', false, false), row('Contrast2012', false, true), row('RedHue', true, true)],
    };
    expect(stateMap(branch)).toEqual({
      Exposure2012: 'predicted',
      Contrast2012: 'leveled',
      RedHue: 'constant',
    });
  });
});

describe('countStates', () => {
  test('counts the map, so the anchor correction is applied once', () => {
    expect(countStates({ a: 'predicted', b: 'predicted', c: 'leveled', d: 'constant' })).toEqual({
      predicted: 2,
      leveled: 1,
      constant: 1,
    });
  });

  test('an empty profile counts nothing rather than throwing', () => {
    expect(countStates({})).toEqual({ predicted: 0, leveled: 0, constant: 0 });
  });
});

describe('summariseStates', () => {
  test('states all three counts against the total', () => {
    const line = summariseStates({ predicted: 10, leveled: 5, constant: 62 });
    expect(line).toContain('10/77 sliders follow the photograph');
    expect(line).toContain('5 take one value per shoot');
    expect(line).toContain('62 stay at your own constant');
  });

  test('names the forced constants, because that reason is not a threshold', () => {
    expect(summariseStates({ predicted: 1, leveled: 0, constant: 3 }, 2)).toMatch(
      /2 of them because predicting them was worse than your average/,
    );
  });

  test('says nothing about forced constants when there are none', () => {
    expect(summariseStates({ predicted: 1, leveled: 0, constant: 3 }, 0)).not.toContain('worse than your average');
  });
});
