/**
 * CLIP text embeddings for research vocabularies, computed once and cached.
 *
 * The shipped model archive carries only the image tower; text is embedded
 * offline with the same tower `scripts/prepare-model-mirror.ts` uses, so the
 * vectors live in the space of the stored image embeddings.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { AutoTokenizer, CLIPTextModelWithProjection } from '@huggingface/transformers';

const MODEL_ID = 'Xenova/clip-vit-base-patch32';

export const unit = (v: readonly number[]): number[] => {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};

/** Unit vectors for `"a photo of <prompt>"`, keyed by name; recomputed when the vocabulary changes. */
export async function textEmbeddings(vocab: Record<string, string>, cacheFile: string): Promise<number[][]> {
  if (existsSync(cacheFile)) {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (JSON.stringify(cached.prompts) === JSON.stringify(vocab)) return cached.embeddings;
  }
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
  const model = await CLIPTextModelWithProjection.from_pretrained(MODEL_ID, { dtype: 'int8' });
  const prompts = Object.values(vocab).map((p) => `a photo of ${p}`);
  const { text_embeds } = (await model(tokenizer(prompts, { padding: true, truncation: true }))) as {
    text_embeds: { data: ArrayLike<number>; dims: number[] };
  };
  const dim = text_embeds.dims[1]!;
  const data = Array.from(text_embeds.data);
  const embeddings = prompts.map((_, i) => unit(data.slice(i * dim, (i + 1) * dim)));
  writeFileSync(cacheFile, JSON.stringify({ prompts: vocab, embeddings }));
  return embeddings;
}

/** Zero-shot readings: 100 × cosine between an image embedding and each text vector. */
export function readings(image: readonly number[], text: readonly number[][]): number[] {
  const e = unit(image);
  return text.map((t) => 100 * t.reduce((a, v, i) => a + v * e[i]!, 0));
}
