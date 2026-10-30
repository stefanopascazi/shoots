/**
 * Florence-2 on onnxruntime-node: image in, task answers out.
 *
 * Four graphs from the ONNX export — vision tower, token embedding, encoder and
 * the merged decoder — driven by a greedy loop with the model's own generation
 * rules (decoder start, forced BOS, no repeated 3-gram). The vision tower runs
 * once per photograph and is reused for every question asked of it, which is
 * most of the saving when one photograph is captioned, grounded and segmented.
 *
 * The CPU provider only: on DirectML the merged decoder returns nothing but
 * padding (measured with tools/florence-probe), and the decoder is where the
 * time goes.
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { InferenceSession, Tensor } from 'onnxruntime-node';
import { createTokenizer, type Tokenizer, type TokenizerJson } from './tokenizer.js';
import { parseBoxes, parsePolygons, parseText, type Boxes } from './parse.js';

/** The task prompts, as the model's processor config states them. */
export const PROMPTS = {
  caption: 'Describe with a paragraph what is shown in the image.',
  detect: 'Locate the objects with category name in the image.',
  ground: (phrases: string) => `Locate the phrases in the caption: ${phrases}`,
  segment: (phrase: string) => `Locate ${phrase} in the image with mask`,
} as const;

const SIZE = 768;
const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;
const DECODER_START = 2;
const MAX_TOKENS = 256;
const NO_REPEAT_NGRAM = 3;
const LAYERS = 6;

type Ort = typeof import('onnxruntime-node');

/** A photograph the vision tower has seen, ready for any number of questions. */
export interface FlorenceImage {
  readonly width: number;
  readonly height: number;
  /** @internal image features from the vision tower */
  readonly features: Tensor;
}

export interface Florence {
  /** Run the vision tower on 8-bit RGB pixels (any size; resized to 768² as the model expects). */
  see(rgb: Uint8Array, width: number, height: number): Promise<FlorenceImage>;
  caption(image: FlorenceImage): Promise<string>;
  detect(image: FlorenceImage): Promise<Boxes>;
  /** Boxes for the phrases that are present; absent phrases simply do not come back. */
  ground(image: FlorenceImage, phrases: readonly string[]): Promise<Boxes>;
  /**
   * Polygons for a phrase. Florence draws a mask for any phrase, present or not,
   * so callers segment only what `ground` or `detect` found.
   */
  segment(image: FlorenceImage, phrase: string): Promise<number[][]>;
}

/** Bilinear resize to 768², then CLIP-style rescale and normalisation, as planar CHW. */
export function preprocess(rgb: Uint8Array, width: number, height: number): Float32Array {
  const out = new Float32Array(3 * SIZE * SIZE);
  const plane = SIZE * SIZE;
  for (let y = 0; y < SIZE; y++) {
    const fy = Math.min(height - 1, Math.max(0, ((y + 0.5) * height) / SIZE - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < SIZE; x++) {
      const fx = Math.min(width - 1, Math.max(0, ((x + 0.5) * width) / SIZE - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(width - 1, x0 + 1);
      const wx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const p = (yy: number, xx: number): number => rgb[(yy * width + xx) * 3 + c]!;
        const v = (p(y0, x0) * (1 - wx) + p(y0, x1) * wx) * (1 - wy) + (p(y1, x0) * (1 - wx) + p(y1, x1) * wx) * wy;
        out[c * plane + y * SIZE + x] = (v / 255 - MEAN[c]!) / STD[c]!;
      }
    }
  }
  return out;
}

/** Tokens that would complete an n-gram already present in the sequence. */
export function bannedNext(seq: readonly number[], n: number): Set<number> {
  const banned = new Set<number>();
  if (seq.length < n - 1) return banned;
  const tail = seq.slice(seq.length - (n - 1));
  for (let i = 0; i + n <= seq.length; i++) {
    let match = true;
    for (let j = 0; j < n - 1 && match; j++) match = seq[i + j] === tail[j];
    if (match) banned.add(seq[i + n - 1]!);
  }
  return banned;
}

export async function loadFlorence(modelDir: string): Promise<Florence> {
  const ort: Ort = await import('onnxruntime-node');
  const tokenizer: Tokenizer = createTokenizer(JSON.parse(await readFile(path.join(modelDir, 'tokenizer.json'), 'utf8')) as TokenizerJson);
  const open = (name: string): Promise<InferenceSession> => ort.InferenceSession.create(path.join(modelDir, 'onnx', name));
  const [vision, embed, encoder, decoder] = await Promise.all([
    open('vision_encoder.onnx'),
    open('embed_tokens.onnx'),
    open('encoder_model.onnx'),
    open('decoder_model_merged.onnx'),
  ]);

  const embedIds = async (ids: readonly number[]): Promise<Tensor> =>
    (await embed.run({ input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]) })).inputs_embeds!;

  async function generate(image: FlorenceImage, prompt: string): Promise<string> {
    const text = await embedIds(tokenizer.encode(prompt));
    // Image tokens first, then the prompt: Florence's own merge order.
    const [, ni, d] = image.features.dims as number[];
    const nt = text.dims[1] as number;
    const merged = new Float32Array((ni! + nt) * d!);
    merged.set(image.features.data as Float32Array, 0);
    merged.set(text.data as Float32Array, ni! * d!);
    const mask = new ort.Tensor('int64', new BigInt64Array(ni! + nt).fill(1n), [1, ni! + nt]);
    const hidden = (await encoder.run({ inputs_embeds: new ort.Tensor('float32', merged, [1, ni! + nt, d!]), attention_mask: mask })).last_hidden_state!;

    // The merged decoder takes an empty cache and use_cache_branch=false on the first step.
    let past: Record<string, Tensor> = {};
    for (let l = 0; l < LAYERS; l++) {
      for (const part of ['decoder', 'encoder']) {
        for (const kv of ['key', 'value']) past[`past_key_values.${l}.${part}.${kv}`] = new ort.Tensor('float32', new Float32Array(0), [1, 12, 0, 64]);
      }
    }
    const out: number[] = [];
    let next = DECODER_START;
    for (let t = 0; t < MAX_TOKENS; t++) {
      const res = await decoder.run({
        inputs_embeds: await embedIds([next]),
        encoder_hidden_states: hidden,
        encoder_attention_mask: mask,
        use_cache_branch: new ort.Tensor('bool', [t > 0], [1]),
        ...past,
      });
      const fresh: Record<string, Tensor> = {};
      for (const [k, v] of Object.entries(res)) {
        if (!k.startsWith('present.')) continue;
        // The encoder cross-attention cache is computed once, on the first step.
        if (t > 0 && k.includes('.encoder.')) continue;
        fresh[k.replace('present.', 'past_key_values.')] = v;
      }
      past = { ...past, ...fresh };
      const logits = res.logits!;
      const vocab = logits.dims[2] as number;
      const row = (logits.data as Float32Array).subarray(0, vocab);
      if (t === 0) {
        next = tokenizer.bos;
      } else {
        const banned = bannedNext(out, NO_REPEAT_NGRAM);
        let best = -Infinity;
        for (let v = 0; v < vocab; v++) {
          if (!banned.has(v) && row[v]! > best) [best, next] = [row[v]!, v];
        }
      }
      out.push(next);
      if (t > 0 && next === tokenizer.eos) break;
    }
    return tokenizer.decode(out);
  }

  return {
    async see(rgb, width, height) {
      const pixels = new ort.Tensor('float32', preprocess(rgb, width, height), [1, 3, SIZE, SIZE]);
      return { width, height, features: (await vision.run({ pixel_values: pixels })).image_features! };
    },
    async caption(image) {
      return parseText(await generate(image, PROMPTS.caption));
    },
    async detect(image) {
      return parseBoxes(await generate(image, PROMPTS.detect), image.width, image.height);
    },
    async ground(image, phrases) {
      return parseBoxes(await generate(image, PROMPTS.ground(phrases.map((p) => `${p}.`).join(' '))), image.width, image.height);
    },
    async segment(image, phrase) {
      return parsePolygons(await generate(image, PROMPTS.segment(phrase)), image.width, image.height);
    },
  };
}
