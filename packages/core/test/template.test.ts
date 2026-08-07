/**
 * Filename templating: the language `import` and `rename` share.
 *
 * The token regex is module-level and global, so its `lastIndex` survives
 * between calls — the exercises below deliberately call the same helpers twice
 * to keep an accidental stateful regex from shipping.
 */
import { describe, expect, test } from 'bun:test';
import {
  renderTemplate,
  sanitizeToken,
  templateNeedsCaptureMetadata,
  validateTemplate,
  TemplateError,
} from '../src/template.js';

const CTX = {
  date: new Date(2026, 7, 2, 9, 5, 3),
  camera: 'Canon EOS R5',
  lens: 'RF 28mm F2.8 STM',
  ext: 'cr3',
  originalName: 'IMG_0042',
  seq: 7,
};

describe('sanitizeToken', () => {
  test('collapses path separators and whitespace into single dashes', () => {
    expect(sanitizeToken('Canon EOS  R5')).toBe('Canon-EOS-R5');
    expect(sanitizeToken('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
  });

  test('trims leading and trailing dashes left by the substitutions', () => {
    expect(sanitizeToken('  spaced  ')).toBe('spaced');
    expect(sanitizeToken('/leading/')).toBe('leading');
  });

  test('can reduce a value to the empty string', () => {
    expect(sanitizeToken('///')).toBe('');
  });
});

describe('renderTemplate', () => {
  test('renders every documented token', () => {
    expect(renderTemplate('{date}_{time}_{year}-{month}-{day}', CTX)).toBe('20260802_090503_2026-08-02');
    expect(renderTemplate('{camera}_{lens}', CTX)).toBe('Canon-EOS-R5_RF-28mm-F2.8-STM');
    expect(renderTemplate('{orig}.{ext}', CTX)).toBe('IMG_0042.cr3');
  });

  test('pads {seq} to the requested width, defaulting to none', () => {
    expect(renderTemplate('{seq}', CTX)).toBe('7');
    expect(renderTemplate('{seq:4}', CTX)).toBe('0007');
    expect(renderTemplate('{seq:2}', { ...CTX, seq: 123 })).toBe('123');
  });

  test('falls back per-token when the metadata is missing', () => {
    const bare = { ext: 'jpg', originalName: 'x' };
    expect(renderTemplate('{date}-{time}-{year}-{month}-{day}', bare)).toBe(
      'nodate-notime-noyear-nomonth-noday',
    );
    expect(renderTemplate('{camera}/{lens}', bare)).toBe('unknown-camera/unknown-lens');
    expect(renderTemplate('{seq}', bare)).toBe('0');
  });

  test('leaves literal text and unknown-shaped braces alone', () => {
    expect(renderTemplate('shoot_{year}_final', CTX)).toBe('shoot_2026_final');
    expect(renderTemplate('{ 42 }', CTX)).toBe('{ 42 }');
  });

  test('rejects an unknown token by name', () => {
    expect(() => renderTemplate('{nope}', CTX)).toThrow(TemplateError);
    expect(() => renderTemplate('{nope}', CTX)).toThrow(/Unknown template token \{nope\}/);
  });
});

describe('templateNeedsCaptureMetadata', () => {
  test('is true for EXIF-derived tokens', () => {
    for (const token of ['date', 'time', 'year', 'month', 'day', 'camera', 'lens']) {
      expect(templateNeedsCaptureMetadata(`x_{${token}}`)).toBe(true);
    }
  });

  test('is false for tokens the file system alone can answer', () => {
    expect(templateNeedsCaptureMetadata('{orig}_{seq:3}.{ext}')).toBe(false);
    expect(templateNeedsCaptureMetadata('no-tokens-at-all')).toBe(false);
  });

  // The shared global regex would otherwise resume mid-pattern on the next call.
  test('gives the same answer when asked twice', () => {
    const pattern = '{camera}_{seq:4}';
    expect(templateNeedsCaptureMetadata(pattern)).toBe(true);
    expect(templateNeedsCaptureMetadata(pattern)).toBe(true);
    expect(renderTemplate(pattern, CTX)).toBe('Canon-EOS-R5_0007');
    expect(templateNeedsCaptureMetadata(pattern)).toBe(true);
  });
});

describe('validateTemplate', () => {
  test('accepts a usable pattern', () => {
    expect(validateTemplate('{date}_{seq:4}.{ext}')).toBeNull();
  });

  test('reports the unknown token rather than throwing', () => {
    expect(validateTemplate('{bogus}')).toMatch(/Unknown template token \{bogus\}/);
  });

  test('rejects a pattern that renders to nothing', () => {
    expect(validateTemplate('')).toBe('Template renders to an empty name');
  });
});
