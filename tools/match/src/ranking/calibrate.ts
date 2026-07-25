/**
 * Star calibration — turn raw s(x) = w·x + b into a 0..5 mapping.
 *
 * Two steps: (1) normalize s into a stable [0,1] via a logistic on the
 * standardized score (mean/std from the labeled set); (2) place the star
 * cut-offs at percentiles of that normalized distribution. Percentile placement
 * makes "5 stars = my top ~10%" hold regardless of the raw score scale, and the
 * severity is a property of the percentile choice, not of the model.
 */
export interface Calibration {
  scoreNormalization: { mean: number; std: number };
  aestheticStars: { min: number; stars: number }[];
}

/** Default keeper bar: demanding but not empty. Fractions are top-of-distribution. */
const STAR_PERCENTILES: { p: number; stars: number }[] = [
  { p: 0.9, stars: 5 }, // top 10%
  { p: 0.75, stars: 4 },
  { p: 0.5, stars: 3 },
  { p: 0.3, stars: 2 },
  { p: 0.1, stars: 1 }, // below the 10th percentile → 0
];

const logistic = (z: number): number => 1 / (1 + Math.exp(-z));

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx]!;
}

export function calibrate(rawScores: number[]): Calibration {
  const n = rawScores.length;
  const mean = rawScores.reduce((a, b) => a + b, 0) / (n || 1);
  const variance = rawScores.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n || 1);
  const std = Math.sqrt(variance) || 1;

  const normalized = rawScores.map((s) => logistic((s - mean) / std)).sort((a, b) => a - b);

  const aestheticStars = STAR_PERCENTILES.map(({ p, stars }) => ({
    min: Math.round(quantile(normalized, p) * 1e4) / 1e4,
    stars,
  }));

  return {
    scoreNormalization: { mean: Math.round(mean * 1e6) / 1e6, std: Math.round(std * 1e6) / 1e6 },
    aestheticStars,
  };
}
