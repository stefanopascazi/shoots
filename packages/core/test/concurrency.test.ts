/**
 * How wide a batch command runs by default.
 *
 * The numbers themselves came from measurement and live in the source; what can
 * be checked here is that they stay sane on whatever machine runs the tests —
 * including the small ones, where scaling with the core count is the difference
 * between a sensible default and a thrashing one.
 */
import { describe, expect, test } from 'bun:test';
import os from 'node:os';
import { defaultImageConcurrency, defaultModelConcurrency } from '../src/jobs/concurrency.js';

const cpus = os.cpus().length;

describe('defaultImageConcurrency', () => {
  test('scales with the machine', () => {
    expect(defaultImageConcurrency()).toBe(Math.min(cpus, 16));
  });

  test('is capped, so a very large host does not spend gigabytes on the last few percent', () => {
    // Peak resident size grows about 25MB per worker; throughput stops
    // improving well before the memory does.
    expect(defaultImageConcurrency()).toBeLessThanOrEqual(16);
  });

  test('never returns something a queue cannot use', () => {
    expect(defaultImageConcurrency()).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(defaultImageConcurrency())).toBe(true);
  });
});

describe('defaultModelConcurrency', () => {
  test('sits at half the core count, where the measured peak is', () => {
    // ONNX Runtime saturates the machine from inside each call, so workers past
    // that point compete with the inference they are waiting on.
    expect(defaultModelConcurrency()).toBe(Math.max(1, Math.min(Math.round(cpus / 2), 8)));
  });

  test('stays at or below the decode-bound default, never above', () => {
    expect(defaultModelConcurrency()).toBeLessThanOrEqual(defaultImageConcurrency());
  });

  test('is at least one, even on a single-core host', () => {
    expect(defaultModelConcurrency()).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(defaultModelConcurrency())).toBe(true);
  });
});
