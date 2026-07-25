/**
 * In-memory Elo used only to CHOOSE informative duels during `serve` (the
 * ground truth for training stays the `comparisons` table). Recomputing full
 * Bradley-Terry every click would be wasteful; a cheap online Elo, seeded from
 * the neutral CLIP aesthetic, is enough to pick good pairs.
 *
 * Active learning: prefer the least-compared photo, then an opponent closest to
 * it in current Elo — that is where a click is most informative (near-ties and
 * under-explored photos), instead of re-confirming obvious blow-outs.
 */
export interface EloState {
  ratings: Map<number, number>;
  counts: Map<number, number>;
}

const BASE = 1500;
const K = 32;

/** Seed Elo from the neutral aesthetic (0..1) so the first duels already refine. */
export function initElo(photos: { id: number; clip_score: number | null }[], counts: Map<number, number>): EloState {
  const ratings = new Map<number, number>();
  for (const p of photos) {
    const seed = p.clip_score ?? 0.5;
    ratings.set(p.id, BASE + (seed - 0.5) * 400); // ±200 around base
  }
  return { ratings, counts: new Map(counts) };
}

export function applyOutcome(state: EloState, winnerId: number, loserId: number): void {
  const rw = state.ratings.get(winnerId) ?? BASE;
  const rl = state.ratings.get(loserId) ?? BASE;
  const expected = 1 / (1 + Math.pow(10, (rl - rw) / 400));
  state.ratings.set(winnerId, rw + K * (1 - expected));
  state.ratings.set(loserId, rl - K * (1 - expected));
  state.counts.set(winnerId, (state.counts.get(winnerId) ?? 0) + 1);
  state.counts.set(loserId, (state.counts.get(loserId) ?? 0) + 1);
}

/** Pick an informative pair, or null when fewer than two photos exist. */
export function selectPair(state: EloState): [number, number] | null {
  const ids = [...state.ratings.keys()];
  if (ids.length < 2) return null;

  // Bias A toward the least-compared photos: take the bottom quartile by count
  // and pick one at random (avoids always showing the same frame).
  const byCount = ids.slice().sort((x, y) => (state.counts.get(x) ?? 0) - (state.counts.get(y) ?? 0));
  const poolSize = Math.max(1, Math.floor(byCount.length / 4));
  const a = byCount[Math.floor(Math.random() * poolSize)]!;

  // B = the closest in Elo to A (most uncertain outcome), among a few random
  // candidates to keep pairings varied.
  const ra = state.ratings.get(a)!;
  let best = -1;
  let bestDelta = Infinity;
  const tries = Math.min(ids.length - 1, 40);
  for (let t = 0; t < tries; t++) {
    const cand = ids[Math.floor(Math.random() * ids.length)]!;
    if (cand === a) continue;
    const delta = Math.abs((state.ratings.get(cand) ?? BASE) - ra);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = cand;
    }
  }
  if (best === -1) {
    best = ids.find((x) => x !== a)!;
  }
  return [a, best];
}
