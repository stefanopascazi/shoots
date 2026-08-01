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
  /**
   * Whether the session block — the same colour features averaged over the shoot
   * — is narrowed by `colour` too, or passed whole.
   *
   * Measured, and the two halves disagree. Narrowing it costs the tonal
   * parameters dearly (Exposure 10.2% -> -0.9%, Contrast 23.8% -> -2.5%): what
   * the rest of the shoot looks like IS the exposure decision, more than the
   * single frame is. It pays for the taste parameters, where the same columns
   * are only noise (Clarity -34.6% -> -5.6%, Texture -6.2% -> +2.2%).
   */
  narrowSession?: boolean;
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
  presence: { colour: TONE_COLOUR, embedding: true, narrowSession: true },
  // Curve knots and calibration have no measured story of their own yet; they
  // keep the full vector rather than inheriting a guess made for another group.
  paramCurve: { colour: 'all', embedding: true },
  calibration: { colour: 'all', embedding: true },
};

/**
 * Per-parameter overrides, where the *cause* of a choice is narrower than its
 * group's.
 *
 * A photographer who exposes for the highlights takes one decision at capture —
 * nothing clipped on the right — and Blacks at -100 is its consequence, not a
 * separate aesthetic act. So Blacks and Whites are questions about where the
 * histogram ends, while Exposure is a question about where its bulk sits. Same
 * group, different evidence.
 *
 * Anything absent here inherits its group's set.
 */
const PARAM_SETS: Record<string, FeatureSet> = {
  // The ends of the histogram: what was sacrificed, and what was protected.
  // shadowFloor earns its place: dropping it takes Blacks from 4.7% to 3.1%.
  // Note it was nearly cut on a bad comparison — the 6.8% it was measured against
  // came from the run where the session block still leaked the masked columns
  // back in (see ca0532d), so that figure belonged to a different model. Once the
  // leak was closed, the honest baseline for this set is 3.1%.
  Blacks2012: { colour: ['clipShadow', 'shadowFloor', 'lumaMedian', 'lumaStd'], embedding: false },
  Whites2012: { colour: ['clipHigh', 'lumaP99', 'lumaMedian', 'lumaStd'], embedding: false },
  // Where the bulk of the light sits, which is the exposure decision itself.
  Exposure2012: { colour: ['lumaMedian', 'lumaMean', 'shadowFloor', 'lumaP99'], embedding: false },
  Highlights2012: { colour: ['clipHigh', 'lumaP99', 'lumaMean', 'lumaStd'], embedding: false },
  Shadows2012: { colour: ['clipShadow', 'shadowFloor', 'lumaMean', 'lumaStd'], embedding: false },
  // Detail energy is the whole question: is there sand, foliage, fabric — or skin.
  Texture: { colour: ['detailFine', 'detailCoarse', 'lumaStd', 'satMean'], embedding: true, narrowSession: true },
  Clarity2012: { colour: ['detailCoarse', 'detailFine', 'lumaStd', 'lumaMedian'], embedding: true, narrowSession: true },
  // Haze lifts the dark channel and flattens local contrast.
  Dehaze: { colour: ['darkChannel', 'detailCoarse', 'lumaStd', 'satMean'], embedding: true, narrowSession: true },
};

/**
 * Parameters sharing a mask are fitted together, so this key is what buckets them.
 *
 * Named parameters get their own bucket — one extra normal-equation system each,
 * which on a few hundred rows is cheap next to being fitted on evidence that does
 * not describe the decision.
 */
export function featureSetKey(key: string, group: string): string {
  if (PARAM_SETS[key]) return `param:${key}`;
  return SETS[group] ? group : '*';
}

/**
 * Column mask for a parameter group, over the assembled feature vector.
 *
 * Session context and the render one-hot are always kept: they condition *what
 * the shoot looks like* and *what the base rendering was*, which every parameter
 * needs regardless of the evidence it reads from the frame itself.
 */
export function featureMask(key: string, group: string, layout: FeatureLayout): boolean[] {
  const set = PARAM_SETS[key] ?? SETS[group];
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
  // The session block is the SAME colour features averaged over the shoot, so it
  // has to take the same mask. Letting it through whole was the bug that made
  // every earlier masking experiment measure exactly zero: four selected columns
  // arrived alongside fifty session columns carrying the very features that had
  // just been excluded, and the fit read them right back.
  for (let i = 0; i < layout.session; i++) {
    mask[at + i] =
      !set.narrowSession || set.colour === 'all' || set.colour.includes(COLOR_FEATURE_NAMES[i] ?? '');
  }
  at += layout.session;
  for (let i = 0; i < layout.asShot + layout.render; i++) mask[at + i] = true;
  return mask;
}

/** Zero the columns a group may not see; widths are preserved. */
export function applyMask(x: number[], mask: boolean[]): number[] {
  const out = new Array<number>(x.length);
  for (let i = 0; i < x.length; i++) out[i] = mask[i] ? x[i]! : 0;
  return out;
}
