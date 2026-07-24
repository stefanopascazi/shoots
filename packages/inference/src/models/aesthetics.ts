/**
 * Zero-shot CLIP aesthetic scoring across several quality dimensions.
 *
 * A single "is this a good photo?" prompt is a blunt instrument. Instead we
 * score the image against a handful of contrastive aspect pairs — composition,
 * exposure, subject, lighting, sharpness, storytelling — each a positive prompt
 * ("a well composed photograph") versus its negative ("a poorly composed
 * photograph"). For every aspect the image embedding's cosine similarity to the
 * positive vs the negative prompt is turned into a probability via a temperature
 * softmax (CLIP's logit-scale convention), and the weighted mean across aspects
 * is the aesthetic score in [0, 1].
 *
 * The prompt text embeddings are precomputed offline (scripts/prepare-model-
 * mirror.ts) and shipped as JSON inside the model archive, so runtime needs only
 * the image encoder plus dot products — no text encoder, staying MIT-clean.
 *
 * The file is OPTIONAL in the archive: older archives ship only keywords.json.
 * When it is absent, {@link loadAestheticModel} returns null and callers fall
 * back to the technical heuristic. This keeps `--model onnx` working before the
 * mirror is rebuilt with aesthetics.json.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { AestheticAspectScore } from '../QualityModel.js';

export interface AestheticModelFile {
  model: string;
  dim: number;
  /** CLIP logit scale used to sharpen the pos/neg softmax. Typically ~100. */
  temperature: number;
  aspects: {
    name: string;
    /** Relative importance in the aggregate (defaults to 1). */
    weight?: number;
    positive: number[];
    negative: number[];
  }[];
}

interface LoadedAspect {
  name: string;
  weight: number;
  /** L2-normalized positive prompt embedding. */
  positive: Float32Array;
  /** L2-normalized negative prompt embedding. */
  negative: Float32Array;
}

export interface AestheticModel {
  dim: number;
  temperature: number;
  aspects: LoadedAspect[];
}

function l2normalize(src: ArrayLike<number>): Float32Array {
  const out = new Float32Array(src.length);
  let s = 0;
  for (let i = 0; i < src.length; i++) s += src[i] * src[i];
  const inv = 1 / (Math.sqrt(s) || 1);
  for (let i = 0; i < src.length; i++) out[i] = src[i] * inv;
  return out;
}

/**
 * Load and validate the aesthetic prompt model. Returns null when the archive
 * predates aesthetics (file missing), so the caller can fall back cleanly.
 */
export async function loadAestheticModel(path: string): Promise<AestheticModel | null> {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(await readFile(path, 'utf8')) as AestheticModelFile;
  const { dim, temperature, aspects } = parsed;
  if (!Number.isInteger(dim) || dim <= 0 || !Array.isArray(aspects) || aspects.length === 0) {
    throw new Error(`Invalid aesthetic model at ${path}`);
  }
  const loaded: LoadedAspect[] = aspects.map((a, i) => {
    if (
      !a.name ||
      !Array.isArray(a.positive) ||
      a.positive.length !== dim ||
      !Array.isArray(a.negative) ||
      a.negative.length !== dim
    ) {
      throw new Error(`Invalid aesthetic aspect #${i} in ${path}`);
    }
    return {
      name: a.name,
      weight: typeof a.weight === 'number' && a.weight > 0 ? a.weight : 1,
      positive: l2normalize(a.positive),
      negative: l2normalize(a.negative),
    };
  });
  return { dim, temperature: temperature > 0 ? temperature : 100, aspects: loaded };
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export interface AestheticScoreResult {
  /** Weighted-mean aesthetic in [0, 1]. */
  aesthetic: number;
  /** Per-aspect probabilities, for provenance in sidecars. */
  aspects: AestheticAspectScore[];
}

/**
 * Score a single (L2-normalized) image embedding against every aspect pair.
 * For each aspect, P(positive) = sigmoid(temperature · (cosPos − cosNeg)),
 * i.e. a two-class softmax over the pos/neg prompts.
 */
export function scoreAesthetics(model: AestheticModel, imageEmbedding: Float32Array): AestheticScoreResult {
  const perAspect: AestheticAspectScore[] = [];
  let weighted = 0;
  let weightSum = 0;
  for (const aspect of model.aspects) {
    const diff = dot(aspect.positive, imageEmbedding) - dot(aspect.negative, imageEmbedding);
    const prob = 1 / (1 + Math.exp(-model.temperature * diff));
    perAspect.push({ name: aspect.name, score: Math.round(prob * 1000) / 1000 });
    weighted += aspect.weight * prob;
    weightSum += aspect.weight;
  }
  return { aesthetic: weightSum > 0 ? weighted / weightSum : 0, aspects: perAspect };
}
