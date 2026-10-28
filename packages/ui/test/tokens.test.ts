/**
 * The palette is checked, not eyeballed: every text/background pairing the
 * components actually use must meet WCAG AA in both themes.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { contrastRatio } from '../src/color/contrast.js';
import { UI_CSS } from '../src/css.js';

const TOKENS = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');

/** Custom properties declared in the first block that follows `selector`. */
function block(selector: string): Record<string, string> {
  const start = TOKENS.indexOf(selector);
  if (start < 0) throw new Error(`selector not found: ${selector}`);
  const open = TOKENS.indexOf('{', start);
  const body = TOKENS.slice(open + 1, TOKENS.indexOf('}', open));
  return Object.fromEntries([...body.matchAll(/(--sh-[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const dark = block(':root {');
const lightForced = block(':root[data-theme="light"]');
const lightSystem = block(':root:not([data-theme="dark"])');
const light = { ...dark, ...lightForced };

describe('tokens', () => {
  test('the forced and the system light theme are the same palette', () => {
    expect(lightSystem).toEqual(lightForced);
  });

  test('light overrides only tokens that exist in dark', () => {
    for (const k of Object.keys(lightForced)) expect(dark).toHaveProperty(k);
  });

  // [foreground, background, minimum ratio]
  const PAIRS: Array<[string, string, number]> = [
    ['--sh-fg', '--sh-bg', 7],
    ['--sh-fg', '--sh-surface', 7],
    ['--sh-fg-muted', '--sh-bg', 4.5],
    ['--sh-fg-muted', '--sh-surface-2', 4.5],
    ['--sh-fg-subtle', '--sh-surface', 4],
    ['--sh-accent-fg', '--sh-accent', 4.5],
    ['--sh-accent-fg', '--sh-accent-hover', 4.5],
    ['--sh-accent-text', '--sh-surface', 4.5],
    ['--sh-success', '--sh-surface', 4.5],
    ['--sh-warning', '--sh-surface', 4.5],
    ['--sh-danger', '--sh-surface', 4.5],
    ['--sh-info', '--sh-surface', 4.5],
  ];

  for (const [name, theme] of [['dark', dark], ['light', light]] as const) {
    for (const [fg, bg, min] of PAIRS) {
      test(`${name}: ${fg} on ${bg} >= ${min}`, () => {
        expect(contrastRatio(theme[fg], theme[bg])).toBeGreaterThanOrEqual(min);
      });
    }
  }

  test('the bundled stylesheet carries tokens and components', () => {
    expect(UI_CSS).toContain('--sh-accent');
    expect(UI_CSS).toContain('.sh-btn');
    expect(UI_CSS).toContain('.sh-photo');
  });
});
