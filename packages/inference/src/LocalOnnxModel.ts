/**
 * ONNX-backed QualityModel (the real backend behind `--model onnx`).
 *
 * - focus:     variance-of-Laplacian (classic, no ML) via @shoots/imaging.
 * - aesthetic: zero-shot CLIP across quality aspects (composition, exposure,
 *              subject, lighting, sharpness, storytelling) when the model
 *              archive ships aesthetics.json; otherwise a cheap technical
 *              heuristic (exposure / contrast / colorfulness) as a fallback.
 * - keywords:  zero-shot CLIP — the ONNX image encoder embeds the photo, then
 *              cosine similarity against precomputed text embeddings shipped in
 *              the model archive.
 *
 * A single image embedding feeds both the aesthetic aspects and the keywords.
 *
 * The CLIP model (MIT, openai/clip-vit-base-patch32 in ONNX form) is downloaded
 * on first use into ~/.shoots/models, checksum-verified. The onnxruntime-node
 * runtime is imported lazily so nothing loads it until the backend is used.
 * In production `--model onnx` fails cleanly at init() with
 * ModelMirrorNotConfiguredError until the model mirror is built and pinned.
 */
import type { InferenceSession, Tensor } from 'onnxruntime-node';
import {
  loadRenderableImage,
  laplacianVariance,
  preprocessClip,
  aestheticStats,
  type AestheticStats,
  DEFAULT_FOCUS_THRESHOLD,
} from '@shoots/imaging';
import type {
  ImageInput,
  MeasureOptions,
  QualityAssessment,
  QualityMeasurement,
  QualityModel,
} from './QualityModel.js';
import {
  CLIP_INPUT,
  CLIP_MODEL_VERSION,
  ensureClipModel,
  type EnsureModelOptions,
  type ResolvedModelManifest,
} from './models/clipManifest.js';
import { loadKeywordVocab, matchKeywords, type KeywordVocab } from './models/keywords.js';
import { loadAestheticModel, scoreAesthetics, type AestheticModel } from './models/aesthetics.js';
import type { LinearEmbeddingProfile, RatingProfile } from './profiles.js';

/** How many keywords to suggest, and the minimum cosine similarity to keep one. */
const KEYWORD_TOP_K = 6;
const KEYWORD_FLOOR = 0.2;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Technical-only aesthetic fallback used when the archive has no aesthetics.json.
 * Deliberately conservative: a merely well-exposed frame should not score high
 * on its own — that is the job of the CLIP aspects. Well-exposed, contrasty and
 * colourful lifts it, but the ceiling here is modest so the strict star mapping
 * still separates snapshots from keepers.
 */
function heuristicAesthetic(stats: AestheticStats): number {
  const exposure = 1 - Math.min(1, 2 * Math.abs(stats.brightness - 0.5));
  const contrast = Math.min(1, stats.contrast * 2);
  const colour = Math.min(1, stats.colorfulness * 1.6);
  // Weighted, then scaled down: technical cleanliness alone caps around 0.7.
  return clamp01(0.7 * (0.5 * exposure + 0.3 * contrast + 0.2 * colour));
}

function l2normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  const inv = 1 / (Math.sqrt(s) || 1);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}

/**
 * Aesthetic merit from a learned linear head: s = w·x + b, standardized and
 * squashed into [0,1] with a logistic — matching the calibration tools/match
 * used to place the star cut-offs.
 */
function linearAesthetic(profile: LinearEmbeddingProfile, embedding: Float32Array): number {
  const w = profile.weights;
  let s = profile.bias;
  for (let i = 0; i < w.length; i++) s += w[i] * embedding[i];
  const z = (s - profile.scoreNormalization.mean) / (profile.scoreNormalization.std || 1);
  return clamp01(1 / (1 + Math.exp(-z)));
}

export class LocalOnnxModel implements QualityModel {
  readonly name = `onnx-clip/${CLIP_MODEL_VERSION}`;

  private manifest?: ResolvedModelManifest;
  private session?: InferenceSession;
  private vocab?: KeywordVocab;
  private aesthetics: AestheticModel | null = null;
  private ort?: typeof import('onnxruntime-node');

  constructor(
    private readonly profile: RatingProfile,
    private readonly options: EnsureModelOptions = {},
  ) {
    // A learned profile is valid only in the CLIP space it was trained on.
    if (profile.type === 'linear-embedding' && profile.embeddingModel !== this.name) {
      throw new Error(
        `profile '${profile.name}' was trained on embedding model '${profile.embeddingModel}', ` +
          `but this backend is '${this.name}' — spaces differ, refusing to score`,
      );
    }
  }

  async init(): Promise<void> {
    this.manifest = await ensureClipModel(this.options);
    this.vocab = await loadKeywordVocab(this.manifest.vocabPath);
    // Optional: null on archives that predate aesthetics.json → heuristic fallback.
    this.aesthetics = await loadAestheticModel(this.manifest.aestheticsPath);
    // Lazy import: the onnxruntime native addon loads only when the onnx backend
    // is actually used, keeping startup (and other commands) free of it.
    this.ort = await import('onnxruntime-node');
    this.session = await this.ort.InferenceSession.create(this.manifest.imageEncoderPath);
  }

  private ready(): { session: InferenceSession; vocab: KeywordVocab; ort: typeof import('onnxruntime-node') } {
    if (!this.session || !this.vocab || !this.ort) {
      throw new Error(`${this.name}: init() must be called before scoring`);
    }
    return { session: this.session, vocab: this.vocab, ort: this.ort };
  }

  /** Embed an image into the shared CLIP space (L2-normalized). */
  private async embed(buffer: Buffer): Promise<Float32Array> {
    const { session, ort } = this.ready();
    const pixels = await preprocessClip(buffer, CLIP_INPUT);
    const feeds: Record<string, Tensor> = {
      pixel_values: new ort.Tensor('float32', pixels, [1, 3, CLIP_INPUT.size, CLIP_INPUT.size]),
    };
    const results = await session.run(feeds);
    return l2normalize(results.image_embeds.data as Float32Array);
  }

  /**
   * The expensive half: one decode, then everything that needs the pixels.
   *
   * `options.focusPeak` lets a caller that already knows how sharp the frame is
   * — from the derived cache, or from a `cull` that ran earlier — skip the
   * Laplacian. The decode itself is not optional: the embedding needs it.
   */
  async measure(image: ImageInput, options: MeasureOptions = {}): Promise<QualityMeasurement> {
    this.ready();
    const { buffer, source } = await loadRenderableImage(image.path);

    // Focus: robust local sharpness peak. Mapped into [0,1] later, in interpret().
    const laplacian = options.focusPeak === undefined ? await laplacianVariance(buffer) : undefined;
    const focusPeak = options.focusPeak ?? laplacian!.focusPeak;

    const embedding = await this.embed(buffer);
    // Only archives shipping no aesthetics head need these — but *every* profile
    // on such an archive needs them, not just the one this instance carries. A
    // measurement is meant to be profile-independent so that a cache can keep it
    // and any profile can interpret it later; skipping the statistics because
    // *this* profile would not have used them makes the stored measurement a
    // lie, and the next profile to read it would silently score against neutral
    // constants instead of the photograph.
    const stats = this.aesthetics ? undefined : await aestheticStats(buffer);

    return { embedding, focusPeak, stats, laplacian, pixelSource: source };
  }

  /**
   * The cheap half: arithmetic over a measurement, under this model's profile.
   *
   * Nothing here touches a file, which is the point — a measurement kept from a
   * previous run is interpreted exactly like one taken a microsecond ago.
   */
  interpret(measurement: QualityMeasurement): QualityAssessment {
    const { vocab } = this.ready();
    const clipEmbedding = measurement.embedding;

    // Half at the default focus threshold, which keeps shallow-depth-of-field
    // keepers scoring high.
    const focus = measurement.focusPeak / (measurement.focusPeak + DEFAULT_FOCUS_THRESHOLD);

    // One image embedding feeds both the aesthetic aspects and the keywords.
    const keywords = matchKeywords(vocab, clipEmbedding, KEYWORD_TOP_K, KEYWORD_FLOOR);

    // Aesthetic merit depends on the profile kind:
    //  - linear-embedding (learned): a linear head straight on the embedding;
    //  - aspect-weights (built-in): weighted mean of the zero-shot CLIP aspects,
    //    or a conservative technical heuristic when the archive ships no aspects.
    // The per-aspect scores are profile-independent, so we still surface them for
    // provenance whenever the aesthetics archive is present.
    let aesthetic: number;
    let aspects: QualityAssessment['aspects'] = [];
    if (this.profile.type === 'linear-embedding') {
      aesthetic = linearAesthetic(this.profile, clipEmbedding);
      if (this.aesthetics) aspects = scoreAesthetics(this.aesthetics, clipEmbedding, {}).aspects;
    } else if (this.aesthetics) {
      const scored = scoreAesthetics(this.aesthetics, clipEmbedding, this.profile.meritWeights);
      aesthetic = scored.aesthetic;
      aspects = scored.aspects;
    } else if (measurement.stats) {
      aesthetic = heuristicAesthetic(measurement.stats);
    } else {
      // Refused rather than defaulted. Without the statistics this branch has
      // nothing about the photograph to score, and quietly substituting neutral
      // constants would give every frame in a shoot the same merit — plausible
      // output, uniformly wrong, with nothing to point at. measure() always
      // supplies them for an archive that has no aesthetics head.
      throw new Error(
        `${this.name}: this archive ships no aesthetics head, so the heuristic needs the ` +
          'image statistics, and this measurement carries none',
      );
    }

    // Surface the raw embedding for preference-learning tooling. Rounded to 6
    // decimals (same convention as keyword/aesthetic scores) to roughly halve
    // the JSON size without perturbing the CLIP cosine space. Callers decide
    // whether to persist it (opt-in), so this stays cheap in the common path.
    const embedding = Array.from(clipEmbedding, (x) => Math.round(x * 1e6) / 1e6);

    return { focus: clamp01(focus), aesthetic: clamp01(aesthetic), aspects, keywords, embedding };
  }

  /** Both halves, for callers with nothing cached to contribute. */
  async assess(image: ImageInput): Promise<QualityAssessment> {
    return this.interpret(await this.measure(image));
  }

  async scoreFocus(image: ImageInput): Promise<number> {
    return (await this.assess(image)).focus;
  }

  async scoreAesthetic(image: ImageInput): Promise<number> {
    return (await this.assess(image)).aesthetic;
  }

  async suggestKeywords(image: ImageInput): Promise<string[]> {
    return (await this.assess(image)).keywords;
  }

  async dispose(): Promise<void> {
    await this.session?.release();
    this.session = undefined;
    this.vocab = undefined;
    this.aesthetics = null;
  }
}
