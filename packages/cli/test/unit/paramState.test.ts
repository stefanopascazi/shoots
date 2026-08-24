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
  headEmitsConstant,
  PARAM_STATES,
  paramState,
  stateMap,
  summariseStates,
} from '../../src/develop/develop/paramState.js';

const live = { gated: false, response: 1 };
const gated = { gated: true, response: 1 };
/** Not gated, but a de-shrinking slope of zero: it emits its mean all the same. */
const flat = { gated: false, response: 0 };

const row = (
  key: string,
  level: { gated: boolean; response: number },
  frame: { gated: boolean; response: number },
  state?: 'predicted' | 'leveled' | 'constant',
) => ({ key, level, frame, ...(state ? { state } : {}) });

describe('paramState', () => {
  test('both heads live means the value follows the photograph', () => {
    expect(paramState(live, live)).toBe('predicted');
  });

  test('a gated frame head means one value for the whole shoot', () => {
    expect(paramState(live, gated)).toBe('leveled');
  });

  test('both heads gated means the photographer own constant', () => {
    expect(paramState(gated, gated)).toBe('constant');
  });

  // A live frame head with a gated level one still moves per photograph — the
  // shoot sits at the catalog constant and the frame departs from it.
  test('a gated level head alone still predicts per frame', () => {
    expect(paramState(gated, live)).toBe('predicted');
  });

  // The trap this exists to close: inference multiplies the departure from the
  // mean by the response, so a slope of zero returns the mean exactly as a gate
  // does. On the B&W branch that mislabelled 26 of 41 sliders as predicted.
  test('a response of zero is a constant, gate flag or not', () => {
    expect(headEmitsConstant(flat)).toBe(true);
    expect(headEmitsConstant(live)).toBe(false);
    expect(headEmitsConstant(gated)).toBe(true);
    expect(paramState(live, flat)).toBe('leveled');
    expect(paramState(flat, flat)).toBe('constant');
    expect(paramState(gated, flat)).toBe('constant');
  });

  test('a small but non-zero response still moves, so it still predicts', () => {
    expect(paramState(live, { gated: false, response: 0.02 })).toBe('predicted');
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
        row('Exposure2012', live, live, 'predicted'),
        row('Contrast2012', live, gated, 'leveled'),
        row('RedHue', gated, gated, 'constant'),
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
      perParam: [row('Dehaze', gated, gated, 'constant'), row('RedHue', gated, gated, 'constant')],
      anchors: { Dehaze: { gain: 1 } },
    };
    expect(stateMap(branch)).toEqual({ Dehaze: 'predicted', RedHue: 'constant' });
  });

  test('reconstructs the state for a profile written before it was recorded', () => {
    const branch = {
      perParam: [row('Exposure2012', live, live), row('Contrast2012', live, gated), row('RedHue', gated, gated)],
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
