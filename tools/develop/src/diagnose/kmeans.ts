/**
 * Tiny deterministic k-means (k-means++ init) for the style-clustering diagnostic.
 *
 * Data is small (≤ a few thousand × ~50 dims) and we only need a stable, honest
 * partition — no external library, license stays clean.
 */

/** Squared Euclidean distance. */
function dist2(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    s += d * d;
  }
  return s;
}

/** Seeded LCG in [0,1) for reproducible runs. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1103515245 * s + 12345) >>> 0;
    return s / 2 ** 32;
  };
}

export interface KMeansResult {
  assign: number[];
  centroids: number[][];
  /** Sum of squared distances to the assigned centroid (lower = tighter). */
  inertia: number;
}

export function kmeans(X: number[][], k: number, iters = 60, seed = 7): KMeansResult {
  const n = X.length;
  const rand = rng(seed);

  // k-means++ initialization.
  const centroids: number[][] = [X[Math.floor(rand() * n)]!.slice()];
  while (centroids.length < k) {
    const d2 = X.map((x) => Math.min(...centroids.map((c) => dist2(x, c))));
    const total = d2.reduce((a, b) => a + b, 0) || 1;
    let r = rand() * total;
    let idx = 0;
    while (idx < n - 1 && (r -= d2[idx]!) > 0) idx++;
    centroids.push(X[idx]!.slice());
  }

  const assign = new Array<number>(n).fill(0);
  for (let it = 0; it < iters; it++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = dist2(X[i]!, centroids[c]!);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (assign[i] !== best) { assign[i] = best; changed = true; }
    }
    // Recompute centroids.
    const d = X[0]!.length;
    const sums = Array.from({ length: k }, () => new Array<number>(d).fill(0));
    const counts = new Array<number>(k).fill(0);
    for (let i = 0; i < n; i++) {
      const c = assign[i]!;
      counts[c]!++;
      const row = X[i]!;
      const su = sums[c]!;
      for (let j = 0; j < d; j++) su[j]! += row[j]!;
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue; // keep an empty cluster's old centroid
      for (let j = 0; j < d; j++) centroids[c]![j] = sums[c]![j]! / counts[c]!;
    }
    if (!changed && it > 0) break;
  }

  let inertia = 0;
  for (let i = 0; i < n; i++) inertia += dist2(X[i]!, centroids[assign[i]!]!);
  return { assign, centroids, inertia };
}
