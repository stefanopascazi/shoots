/** The style-clustering diagnostic's partitioner. */
import { describe, expect, test } from 'bun:test';
import { kmeans } from '../../src/develop/diagnose/kmeans.js';

/** Three tight, well-separated blobs — any honest k-means finds them. */
const BLOBS: number[][] = [
  ...Array.from({ length: 10 }, (_, i) => [0 + i * 0.01, 0 + i * 0.01]),
  ...Array.from({ length: 10 }, (_, i) => [50 + i * 0.01, 50 + i * 0.01]),
  ...Array.from({ length: 10 }, (_, i) => [-50 + i * 0.01, 60 + i * 0.01]),
];

const groupsOf = (assign: number[]): number[][] => {
  const seen = new Map<number, number[]>();
  assign.forEach((cluster, i) => {
    if (!seen.has(cluster)) seen.set(cluster, []);
    seen.get(cluster)!.push(i);
  });
  return [...seen.values()].map((g) => g.sort((a, b) => a - b)).sort((a, b) => a[0]! - b[0]!);
};

describe('kmeans', () => {
  test('recovers well-separated blobs', () => {
    const { assign } = kmeans(BLOBS, 3);
    expect(groupsOf(assign)).toEqual([
      Array.from({ length: 10 }, (_, i) => i),
      Array.from({ length: 10 }, (_, i) => i + 10),
      Array.from({ length: 10 }, (_, i) => i + 20),
    ]);
  });

  test('is deterministic for a given seed', () => {
    expect(kmeans(BLOBS, 3, 60, 7)).toEqual(kmeans(BLOBS, 3, 60, 7));
  });

  test('returns one assignment per row and k centroids', () => {
    const result = kmeans(BLOBS, 3);
    expect(result.assign.length).toBe(BLOBS.length);
    expect(result.centroids.length).toBe(3);
    expect(result.centroids.every((c) => c.length === 2)).toBe(true);
  });

  test('places each centroid at the mean of its cluster', () => {
    const { assign, centroids } = kmeans(BLOBS, 3);
    for (let c = 0; c < centroids.length; c++) {
      const members = BLOBS.filter((_, i) => assign[i] === c);
      if (members.length === 0) continue;
      for (let j = 0; j < 2; j++) {
        const mean = members.reduce((s, m) => s + m[j]!, 0) / members.length;
        expect(centroids[c]![j]!).toBeCloseTo(mean, 6);
      }
    }
  });

  test('reports inertia as the sum of squared distances to the assigned centroid', () => {
    const { assign, centroids, inertia } = kmeans(BLOBS, 3);
    const recomputed = BLOBS.reduce((s, row, i) => {
      const c = centroids[assign[i]!]!;
      return s + row.reduce((acc, v, j) => acc + (v - c[j]!) ** 2, 0);
    }, 0);
    expect(inertia).toBeCloseTo(recomputed, 6);
  });

  test('gets tighter as k grows', () => {
    expect(kmeans(BLOBS, 3).inertia).toBeLessThan(kmeans(BLOBS, 1).inertia);
  });

  test('k = 1 puts everything in one cluster centred on the mean', () => {
    const { assign, centroids } = kmeans(BLOBS, 1);
    expect(new Set(assign)).toEqual(new Set([0]));
    const mean = BLOBS.reduce((s, r) => s + r[0]!, 0) / BLOBS.length;
    expect(centroids[0]![0]!).toBeCloseTo(mean, 6);
  });

  test('survives asking for more clusters than there are distinct points', () => {
    const result = kmeans([[0, 0], [0, 0], [1, 1]], 3);
    expect(result.centroids.length).toBe(3);
    expect(result.assign.length).toBe(3);
    expect(Number.isFinite(result.inertia)).toBe(true);
  });

  test('handles a single row', () => {
    const result = kmeans([[4, 2]], 1);
    expect(result.assign).toEqual([0]);
    expect(result.centroids[0]).toEqual([4, 2]);
    expect(result.inertia).toBe(0);
  });

  test('reaches the same partition whatever the seed, on separable data', () => {
    const base = groupsOf(kmeans(BLOBS, 3, 60, 7).assign);
    for (const seed of [1, 42, 999]) {
      expect(groupsOf(kmeans(BLOBS, 3, 60, seed).assign)).toEqual(base);
    }
  });
});
