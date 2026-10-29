import { describe, expect, test } from 'bun:test';
import { BANNER, consoleWriter, jobLine } from '../../src/app/consoleNote.js';

describe('the server console window', () => {
  test('the banner says what closing the window does', () => {
    expect(BANNER).toContain('Leave this window open');
    expect(BANNER).toContain('keeps running on its own');
  });

  test('a line per training or calibration, none for photo jobs', () => {
    const at = new Date(2026, 9, 29, 21, 4);
    expect(jobLine('train', at)).toContain('Training started. It keeps running even if this window closes.');
    expect(jobLine('calibrate', at)).toContain('Calibration started');
    expect(jobLine('catalog', at)).toContain('Catalog export check started.');
    expect(jobLine('cull', at)).toBeUndefined();
  });

  test('writes only on Windows, and never throws without a console', () => {
    const out: string[] = [];
    consoleWriter('linux', (t) => out.push(t))('x');
    expect(out).toEqual([]);
    consoleWriter('win32', (t) => out.push(t))('y');
    expect(out).toEqual(['y']);
    expect(() =>
      consoleWriter('win32', () => {
        throw new Error('no console');
      })('z'),
    ).not.toThrow();
  });
});
