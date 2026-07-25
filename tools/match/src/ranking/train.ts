/**
 * Training orchestration: photos + comparisons → LinearEmbeddingProfile.
 *
 * Pipeline: Bradley-Terry latent θ (Stage 1) → ridge head s(x)=w·x+b over the
 * duelled photos (Stage 2) → percentile star calibration → held-out pairwise
 * accuracy as an honesty check. The output is the deliverable JSON contract.
 */
import { fitBradleyTerry, type IndexedComparison } from './bradleyTerry.js';
import { fitRidge, scoreOne } from './ridge.js';
import { calibrate } from './calibrate.js';
import type { Comparison, LinearEmbeddingProfile, PhotoRow } from '../types.js';

export interface TrainInput {
  name: string;
  photos: PhotoRow[];
  comparisons: Comparison[];
  embeddingModel: string;
  dim: number;
  ridgeLambda?: number;
}

export interface TrainOptions {
  /** Fraction of comparisons held out to measure pairwise generalization. */
  holdout?: number;
  bt?: { iterations?: number; learningRate?: number; l2?: number };
}

/** Focus gate defaults — a learned profile judges aesthetics; focus still gates. */
const FOCUS_DEFAULTS = { focusReject: 0.3, focusSoft: 0.55, focusSoftCap: 1 };

function toIndexed(comparisons: Comparison[], idToIdx: Map<number, number>): IndexedComparison[] {
  const out: IndexedComparison[] = [];
  for (const c of comparisons) {
    const w = idToIdx.get(c.winner_id);
    const l = idToIdx.get(c.loser_id);
    if (w !== undefined && l !== undefined) out.push({ winner: w, loser: l });
  }
  return out;
}

/** Fit BT then ridge over the photos that appear in `comparisons`. */
function fitHead(
  photos: PhotoRow[],
  comparisons: Comparison[],
  lambda: number,
  btOpts: TrainOptions['bt'],
): { weights: number[]; bias: number } {
  const idToIdx = new Map(photos.map((p, i) => [p.id, i]));
  const indexed = toIndexed(comparisons, idToIdx);
  const theta = fitBradleyTerry(photos.length, indexed, btOpts);

  // Train the head only on duelled photos (θ ≈ 0 elsewhere carries no signal).
  const duelled = new Set<number>();
  for (const c of indexed) {
    duelled.add(c.winner);
    duelled.add(c.loser);
  }
  const X: Float32Array[] = [];
  const y: number[] = [];
  for (const idx of duelled) {
    X.push(photos[idx]!.embedding);
    y.push(theta[idx]!);
  }
  return fitRidge(X, y, lambda);
}

/** Shuffle a copy with a small deterministic LCG so runs are reproducible. */
function shuffled<T>(items: T[], seed = 12345): T[] {
  const a = items.slice();
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (1103515245 * s + 12345) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function heldOutAccuracy(input: TrainInput, holdout: number, btOpts: TrainOptions['bt']): number | null {
  const all = shuffled(input.comparisons);
  const testSize = Math.floor(all.length * holdout);
  if (testSize < 5 || all.length - testSize < 10) return null; // too little data to be meaningful
  const test = all.slice(0, testSize);
  const train = all.slice(testSize);

  const { weights, bias } = fitHead(input.photos, train, input.ridgeLambda ?? 1, btOpts);
  const byId = new Map(input.photos.map((p) => [p.id, p]));

  let correct = 0;
  let total = 0;
  for (const c of test) {
    const w = byId.get(c.winner_id);
    const l = byId.get(c.loser_id);
    if (!w || !l) continue;
    const sw = scoreOne(weights, bias, w.embedding);
    const sl = scoreOne(weights, bias, l.embedding);
    if (sw > sl) correct++;
    total++;
  }
  return total > 0 ? Math.round((correct / total) * 1e4) / 1e4 : null;
}

export function train(input: TrainInput, options: TrainOptions = {}): LinearEmbeddingProfile {
  const lambda = input.ridgeLambda ?? 1;
  const btOpts = options.bt;

  // Final head on ALL comparisons.
  const { weights, bias } = fitHead(input.photos, input.comparisons, lambda, btOpts);

  // Calibrate stars on the labeled (duelled) photos' scores.
  const duelledIds = new Set<number>();
  for (const c of input.comparisons) {
    duelledIds.add(c.winner_id);
    duelledIds.add(c.loser_id);
  }
  const rawScores = input.photos
    .filter((p) => duelledIds.has(p.id))
    .map((p) => scoreOne(weights, bias, p.embedding));
  const { scoreNormalization, aestheticStars } = calibrate(rawScores);

  const accuracy = heldOutAccuracy(input, options.holdout ?? 0.2, btOpts);

  return {
    name: input.name,
    description: `Learned from ${input.comparisons.length} duels over ${duelledIds.size} photos`,
    type: 'linear-embedding',
    calibrated: true,
    embeddingModel: input.embeddingModel,
    dim: input.dim,
    weights: weights.map((w) => Math.round(w * 1e6) / 1e6),
    bias: Math.round(bias * 1e6) / 1e6,
    scoreNormalization,
    ...FOCUS_DEFAULTS,
    aestheticStars,
    trainedAt: new Date().toISOString(),
    stats: {
      duels: input.comparisons.length,
      photos: duelledIds.size,
      heldOutPairAccuracy: accuracy,
    },
  };
}
