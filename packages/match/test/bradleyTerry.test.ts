/**
 * Stage 1 of the preference loop: duels → latent θ.
 *
 * What matters is the ordering and the two identifiability properties (centered
 * output, θ ≈ 0 for photos nobody duelled) — the absolute magnitudes are a
 * function of the L2 term and are not a contract.
 */
import { describe, expect, test } from 'bun:test';
import { fitBradleyTerry, type IndexedComparison } from '../src/ranking/bradleyTerry.js';

const mean = (a: Float64Array): number => a.reduce((s, v) => s + v, 0) / (a.length || 1);

describe('fitBradleyTerry', () => {
  test('ranks a transitive chain in the right order', () => {
    // 0 beats 1 beats 2 beats 3, repeatedly.
    const comparisons: IndexedComparison[] = [];
    for (let r = 0; r < 5; r++) {
      comparisons.push({ winner: 0, loser: 1 }, { winner: 1, loser: 2 }, { winner: 2, loser: 3 });
    }
    const theta = fitBradleyTerry(4, comparisons);

    expect(theta[0]!).toBeGreaterThan(theta[1]!);
    expect(theta[1]!).toBeGreaterThan(theta[2]!);
    expect(theta[2]!).toBeGreaterThan(theta[3]!);
  });

  test('centers the scores, so a constant shift is not free', () => {
    const theta = fitBradleyTerry(3, [
      { winner: 0, loser: 1 },
      { winner: 0, loser: 2 },
    ]);
    expect(Math.abs(mean(theta))).toBeLessThan(1e-9);
  });

  test('leaves a photo that was never duelled at the centre', () => {
    const theta = fitBradleyTerry(3, [{ winner: 0, loser: 1 }]);
    // Photo 2 saw no duel: its θ carries no signal and must not out-rank a winner.
    expect(Math.abs(theta[2]!)).toBeLessThan(Math.abs(theta[0]!));
    expect(theta[0]!).toBeGreaterThan(theta[2]!);
    expect(theta[2]!).toBeGreaterThan(theta[1]!);
  });

  test('keeps two photos with an even record level with each other', () => {
    const theta = fitBradleyTerry(2, [
      { winner: 0, loser: 1 },
      { winner: 1, loser: 0 },
    ]);
    expect(Math.abs(theta[0]! - theta[1]!)).toBeLessThan(1e-6);
  });

  test('separates more strongly the more consistently a photo wins', () => {
    const few = fitBradleyTerry(2, [{ winner: 0, loser: 1 }]);
    const many = fitBradleyTerry(
      2,
      Array.from({ length: 20 }, () => ({ winner: 0, loser: 1 })),
    );
    expect(many[0]! - many[1]!).toBeGreaterThan(few[0]! - few[1]!);
  });

  test('does not diverge: the L2 term bounds even a photo that only ever wins', () => {
    const theta = fitBradleyTerry(
      2,
      Array.from({ length: 500 }, () => ({ winner: 0, loser: 1 })),
      { iterations: 2000 },
    );
    expect(theta.every(Number.isFinite)).toBe(true);
    expect(Math.abs(theta[0]!)).toBeLessThan(1e4);
  });

  test('returns all zeros when there are no comparisons', () => {
    const theta = fitBradleyTerry(4, []);
    expect(Array.from(theta)).toEqual([0, 0, 0, 0]);
  });

  test('does not divide by zero on an empty photo set', () => {
    expect(fitBradleyTerry(0, []).length).toBe(0);
  });

  test('honours the iteration and learning-rate overrides', () => {
    const comparisons = Array.from({ length: 10 }, () => ({ winner: 0, loser: 1 }));
    const short = fitBradleyTerry(2, comparisons, { iterations: 1, learningRate: 0.1 });
    const long = fitBradleyTerry(2, comparisons, { iterations: 400, learningRate: 0.1 });
    expect(long[0]!).toBeGreaterThan(short[0]!);
  });
});
