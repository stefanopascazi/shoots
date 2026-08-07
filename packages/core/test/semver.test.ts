/** Version comparison, as used to decide whether an update is worth offering. */
import { describe, expect, test } from 'bun:test';
import { compareSemver } from '../src/semver.js';

const sign = (n: number): number => Math.sign(n);

describe('compareSemver', () => {
  test('orders by major, then minor, then patch', () => {
    expect(sign(compareSemver('1.0.0', '0.9.9'))).toBe(1);
    expect(sign(compareSemver('0.7.0', '0.10.0'))).toBe(-1);
    expect(sign(compareSemver('0.7.1', '0.7.0'))).toBe(1);
  });

  test('treats equal cores as equal', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });

  test('ignores a leading v and any case', () => {
    expect(compareSemver('v1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('V1.2.3', 'v1.2.3')).toBe(0);
  });

  test('ignores prerelease and build metadata', () => {
    expect(compareSemver('1.2.3-rc.1', '1.2.3')).toBe(0);
    expect(compareSemver('1.2.3+build.5', '1.2.3')).toBe(0);
  });

  test('ignores surrounding whitespace', () => {
    expect(compareSemver('  1.2.3  ', '1.2.3')).toBe(0);
  });

  test('treats missing or unparseable components as zero', () => {
    expect(compareSemver('1', '1.0.0')).toBe(0);
    expect(compareSemver('1.2', '1.2.0')).toBe(0);
    expect(sign(compareSemver('1.2.x', '1.2.1'))).toBe(-1);
  });
});
