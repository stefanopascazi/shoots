import { describe, expect, test } from 'bun:test';
import { parseThemePreference } from '../src/theme/theme.js';

describe('parseThemePreference', () => {
  test('keeps explicit choices', () => {
    expect(parseThemePreference('dark')).toBe('dark');
    expect(parseThemePreference('light')).toBe('light');
  });

  test('anything else follows the OS', () => {
    expect(parseThemePreference(null)).toBe('system');
    expect(parseThemePreference('sepia')).toBe('system');
  });
});
