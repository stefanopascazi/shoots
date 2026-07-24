/**
 * Keyword vocabulary with precomputed CLIP text embeddings.
 *
 * Zero-shot keywording needs text embeddings to compare against the image
 * embedding. Rather than ship a text encoder + tokenizer and run them at
 * runtime, the vocabulary's text embeddings are computed once offline (see
 * scripts/prepare-model-mirror.ts) and shipped as JSON inside the model archive.
 * Runtime then only needs the image encoder plus a cosine similarity.
 */
import { readFile } from 'node:fs/promises';

export interface KeywordVocabFile {
  model: string;
  dim: number;
  keywords: { label: string; embedding: number[] }[];
}

export interface KeywordVocab {
  labels: string[];
  /** Row-major [labels.length x dim], each row L2-normalized. */
  matrix: Float32Array;
  dim: number;
}

function l2normalizeInto(v: Float32Array, offset: number, dim: number): void {
  let s = 0;
  for (let i = 0; i < dim; i++) s += v[offset + i] * v[offset + i];
  const inv = 1 / (Math.sqrt(s) || 1);
  for (let i = 0; i < dim; i++) v[offset + i] *= inv;
}

/** Load and validate a keyword vocabulary JSON, L2-normalizing every row. */
export async function loadKeywordVocab(path: string): Promise<KeywordVocab> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as KeywordVocabFile;
  const { dim, keywords } = parsed;
  if (!Number.isInteger(dim) || dim <= 0 || !Array.isArray(keywords) || keywords.length === 0) {
    throw new Error(`Invalid keyword vocabulary at ${path}`);
  }
  const labels = new Array<string>(keywords.length);
  const matrix = new Float32Array(keywords.length * dim);
  for (let k = 0; k < keywords.length; k++) {
    const { label, embedding } = keywords[k];
    if (!label || !Array.isArray(embedding) || embedding.length !== dim) {
      throw new Error(`Invalid keyword entry #${k} in ${path}`);
    }
    labels[k] = label;
    matrix.set(embedding, k * dim);
    l2normalizeInto(matrix, k * dim, dim);
  }
  return { labels, matrix, dim };
}

/**
 * Cosine similarities between a single (L2-normalized) image embedding and every
 * vocabulary row. Returns labels sorted by descending similarity, keeping the
 * top `topK` that clear `floor`.
 */
export function matchKeywords(
  vocab: KeywordVocab,
  imageEmbedding: Float32Array,
  topK: number,
  floor: number,
): string[] {
  const { labels, matrix, dim } = vocab;
  const scored: { label: string; sim: number }[] = [];
  for (let k = 0; k < labels.length; k++) {
    let dot = 0;
    const off = k * dim;
    for (let i = 0; i < dim; i++) dot += matrix[off + i] * imageEmbedding[i];
    scored.push({ label: labels[k], sim: dot });
  }
  scored.sort((a, b) => b.sim - a.sim);
  return scored
    .slice(0, topK)
    .filter((s) => s.sim >= floor)
    .map((s) => s.label);
}
