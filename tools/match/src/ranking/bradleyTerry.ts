/**
 * Stage 1 — Bradley-Terry latent scores.
 *
 * Every duel is a relative judgment: P(i beats j) = σ(θ_i − θ_j). We fit the
 * per-photo latent θ by regularized gradient ascent on the log-likelihood. The
 * L2 term keeps θ identifiable (otherwise a constant shift is free) and the mean
 * is subtracted at the end so scores are centered.
 *
 * A photo scarto is NOT "bad" — it is only worse than the opponents it lost to;
 * its θ settles wherever its wins and losses balance. Photos never duelled keep
 * θ ≈ 0 and are excluded from Stage 2 training (they carry no signal).
 */
export interface BradleyTerryOptions {
  iterations?: number;
  learningRate?: number;
  l2?: number;
}

export interface IndexedComparison {
  winner: number; // photo index (0-based)
  loser: number;
}

export function fitBradleyTerry(
  nPhotos: number,
  comparisons: IndexedComparison[],
  opts: BradleyTerryOptions = {},
): Float64Array {
  const iterations = opts.iterations ?? 800;
  const lr = opts.learningRate ?? 0.1;
  const l2 = opts.l2 ?? 0.01;

  const theta = new Float64Array(nPhotos);
  const grad = new Float64Array(nPhotos);

  for (let it = 0; it < iterations; it++) {
    grad.fill(0);
    for (const c of comparisons) {
      const d = theta[c.winner]! - theta[c.loser]!;
      const p = 1 / (1 + Math.exp(-d)); // P(winner beats loser) under current θ
      const g = 1 - p; // ∂/∂θ_winner of log σ(d)
      grad[c.winner]! += g;
      grad[c.loser]! -= g;
    }
    for (let i = 0; i < nPhotos; i++) {
      theta[i]! += lr * (grad[i]! - l2 * theta[i]!);
    }
  }

  // Center for identifiability.
  let mean = 0;
  for (let i = 0; i < nPhotos; i++) mean += theta[i]!;
  mean /= nPhotos || 1;
  for (let i = 0; i < nPhotos; i++) theta[i]! -= mean;

  return theta;
}
