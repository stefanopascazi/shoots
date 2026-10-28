import { describe, expect, test } from 'bun:test';
import { orientFocusMap, reportFocusMap } from '../../src/focusMap.js';

// 3 columns × 2 rows, landscape as the sensor sees it:
//   1 2 3
//   4 5 6
const SENSOR = { cols: 3, rows: 2, tiles: [1, 2, 3, 4, 5, 6] };

describe('orientFocusMap', () => {
  test('6 turns a quarter clockwise, like the thumbnail', () => {
    // 4 1
    // 5 2
    // 6 3
    expect(orientFocusMap(SENSOR, 6)).toEqual({ cols: 2, rows: 3, tiles: [4, 1, 5, 2, 6, 3] });
  });

  test('8 turns a quarter counter-clockwise', () => {
    // 3 6
    // 2 5
    // 1 4
    expect(orientFocusMap(SENSOR, 8)).toEqual({ cols: 2, rows: 3, tiles: [3, 6, 2, 5, 1, 4] });
  });

  test('3 turns it upside down; 2 and 4 mirror', () => {
    expect(orientFocusMap(SENSOR, 3).tiles).toEqual([6, 5, 4, 3, 2, 1]);
    expect(orientFocusMap(SENSOR, 2).tiles).toEqual([3, 2, 1, 6, 5, 4]);
    expect(orientFocusMap(SENSOR, 4).tiles).toEqual([4, 5, 6, 1, 2, 3]);
  });

  test('a turn and its inverse cancel out', () => {
    expect(orientFocusMap(orientFocusMap(SENSOR, 6), 8)).toEqual(SENSOR);
  });

  test('1 and unknown values leave it alone', () => {
    expect(orientFocusMap(SENSOR, 1)).toEqual(SENSOR);
    expect(orientFocusMap(SENSOR, 9)).toEqual(SENSOR);
  });
});

describe('reportFocusMap', () => {
  const frame = (pixelSource: 'file' | 'embedded-preview', w: number, h: number) => ({
    focusMap: { cols: 3, rows: 2, tiles: [1.4, 2, 3, 4, 5, 6.6] },
    pixelSource,
    analyzedWidth: w,
    analyzedHeight: h,
  });

  test('rounds tiles', () => {
    expect(reportFocusMap(frame('file', 300, 200), 1).tiles).toEqual([1, 2, 3, 4, 5, 7]);
  });

  test('turns a RAW preview measured sideways upright', () => {
    expect(reportFocusMap(frame('embedded-preview', 300, 200), 6)).toMatchObject({ cols: 2, rows: 3 });
  });

  test('leaves a preview that was already measured upright', () => {
    expect(reportFocusMap(frame('embedded-preview', 200, 300), 6)).toMatchObject({ cols: 3, rows: 2 });
  });

  test('ordinary files were turned by the analysis itself', () => {
    expect(reportFocusMap(frame('file', 300, 200), 6)).toMatchObject({ cols: 3, rows: 2 });
  });
});
