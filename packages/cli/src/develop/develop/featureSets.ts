/**
 * Which features each parameter group is allowed to see.
 *
 * The shared 47-column vector is not neutral when a catalog is small: fitting
 * Highlights on all 44 colour columns scores *below* the photographer's constant
 * at 40 photographs (-0.019), while the four columns that describe tonality score
 * +0.122 on the same rows and the same ridge. The 16 luma and 12 hue histogram
 * bins are degrees of freedom spent on noise — they cost most exactly when the
 * photographer has just started, which is when the prediction has to earn trust.
 *
 * Measured on the reference catalog (553 edited frames, held-out MAE, skill
 * against the constant):
 *
 *   Highlights   4 tone features 0.122 / 0.213 / 0.201   all 47 -0.019 / 0.159 / 0.186
 *   Shadows      4 tone features 0.108 / 0.116 / 0.102   all 47  0.013 / 0.088 / 0.146
 *   Exposure     4 tone features 0.014 / 0.009 / 0.078   all 47 -0.199 / -0.158 / -0.008
 *                                    (at n = 40 / 160 / 320)
 *
 * Selection is by *block*, never by hand-picking single columns per parameter:
 * the sets below say which kind of evidence a parameter may use, and the ridge
 * still decides what to do with it. Anything not listed is zeroed before the fit
 * — after centering a constant column contributes nothing, so masking is exactly
 * equivalent to dropping the column while keeping every stored width unchanged.
 */
import { COLOR_FEATURE_NAMES } from '@shoots/imaging';

/** Feature blocks in the order {@link assembleFeatures} lays them out. */
export interface FeatureLayout {
  /** Embedding columns kept (0 when dropped, the PCA rank when compressed). */
  embedding: number;
  /** Colour feature count — always the full {@link COLOR_FEATURE_NAMES} width. */
  colour: number;
  /** Session-context width, 0 when the branch could not afford it. */
  session: number;
  /** As-shot scalars (log WB temperature, log ISO, exposure compensation). */
  asShot: number;
  /** One-hot render vocabulary appended last. */
  render: number;
}

/**
 * Colour features that describe *tonality* — where the light sits and how much
 * of it is clipped. The evidence an exposure or highlight decision rests on.
 */
const TONE_COLOUR = ['lumaMean', 'lumaMedian', 'lumaStd', 'clipHigh', 'clipShadow', 'valMean'];

/**
 * Colour features that describe the *cast* of the light. White balance is a
 * question about colour ratios, not about brightness.
 */
const CAST_COLOUR = ['rMean', 'gMean', 'bMean', 'rgRatio', 'bgRatio', 'satMean', 'satStd'];

/** What a parameter group is allowed to look at. */
interface FeatureSet {
  /** Named colour features, or 'all' to keep the whole block. */
  colour: string[] | 'all';
  /** Semantic embedding: only groups whose choice plausibly follows the subject. */
  embedding: boolean;
}

/**
 * Group → evidence. Keyed by {@link DevelopParam.group}, which already exists to
 * describe what a parameter *is*; this says what it may be predicted from.
 *
 * `presence` (Clarity/Texture/Dehaze) keeps the embedding on purpose. On the
 * reference catalog those parameters carry almost no per-photograph modulation —
 * 36 distinct Clarity values across 553 frames, mean ≈ 1 — so nothing can be
 * learned there and the gate correctly falls back to the constant. But a
 * photographer who does push Clarity down on skin and up on landscape is making
 * a choice that follows the *subject*, and only the embedding can see it. Denying
 * the block by decree would make that photographer's style unlearnable; leaving
 * it in costs nothing, because the gate already refuses what does not measure up.
 */
const SETS: Record<string, FeatureSet> = {
  tone: { colour: TONE_COLOUR, embedding: false },
  wb: { colour: CAST_COLOUR, embedding: false },
  presence: { colour: TONE_COLOUR, embedding: true },
  // Curve knots and calibration have no measured story of their own yet; they
  // keep the full vector rather than inheriting a guess made for another group.
  paramCurve: { colour: 'all', embedding: true },
  calibration: { colour: 'all', embedding: true },
};

/** Groups sharing a mask are fitted together, so this key is what buckets them. */
export function featureSetKey(group: string): string {
  return SETS[group] ? group : '*';
}

/**
 * Column mask for a parameter group, over the assembled feature vector.
 *
 * Session context and the render one-hot are always kept: they condition *what
 * the shoot looks like* and *what the base rendering was*, which every parameter
 * needs regardless of the evidence it reads from the frame itself.
 */
export function featureMask(group: string, layout: FeatureLayout): boolean[] {
  const set = SETS[group];
  const width = layout.embedding + layout.colour + layout.session + layout.asShot + layout.render;
  // An unknown group keeps everything — new parameters behave as they did before
  // this file existed until someone measures them.
  if (!set) return new Array<boolean>(width).fill(true);

  const mask = new Array<boolean>(width).fill(false);
  let at = 0;
  for (let i = 0; i < layout.embedding; i++) mask[at + i] = set.embedding;
  at += layout.embedding;
  for (let i = 0; i < layout.colour; i++) {
    mask[at + i] = set.colour === 'all' || set.colour.includes(COLOR_FEATURE_NAMES[i] ?? '');
  }
  at += layout.colour;
  for (let i = 0; i < layout.session + layout.asShot + layout.render; i++) mask[at + i] = true;
  return mask;
}

/** Zero the columns a group may not see; widths are preserved. */
export function applyMask(x: number[], mask: boolean[]): number[] {
  const out = new Array<number>(x.length);
  for (let i = 0; i < x.length; i++) out[i] = mask[i] ? x[i]! : 0;
  return out;
}
