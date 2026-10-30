/**
 * Florence-2 on a photograph: caption, phrase grounding, region masks.
 *
 * A thin research wrapper over `@huggingface/transformers`, loading the model
 * from `~/.shoots/models/florence-2-base-ft` only (never the network). Adds the
 * one post-processing step the library lacks — segmentation polygons — and the
 * rule that keeps it honest: Florence draws a mask for *any* phrase, so a region
 * is segmented only after grounding has found it.
 */
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { AutoProcessor, env, Florence2ForConditionalGeneration, RawImage } from '@huggingface/transformers';
import { loadRenderableImage, readOrientation } from '@shoots/imaging';

export const MODEL_ID = 'florence-2-base-ft';
/** transformers.js dtype names: fp32, q8 (= `_quantized`), q4, fp16… */
export type Dtype = 'fp32' | 'q8' | 'q4' | 'fp16';
/** One dtype for the whole model, or one per ONNX component. */
export type DtypeMap = Dtype | Partial<Record<'vision_encoder' | 'embed_tokens' | 'encoder_model' | 'decoder_model_merged', Dtype>>;
/** onnxruntime execution provider: DirectML on Windows, CUDA on Linux, CoreML on macOS. */
export type Device = 'cpu' | 'dml' | 'cuda' | 'coreml';
/** One device for the whole model, or one per ONNX component. */
export type DeviceMap = Device | Partial<Record<'vision_encoder' | 'embed_tokens' | 'encoder_model' | 'decoder_model_merged', Device>>;

export interface Florence {
  caption(image: RawImage): Promise<string>;
  ground(image: RawImage, phrases: string[]): Promise<{ labels: string[]; bboxes: number[][] }>;
  /** Polygon(s) in image pixels for a phrase. */
  segment(image: RawImage, phrase: string): Promise<number[][]>;
}

/** The Florence-specific processor methods the library ships untyped. */
interface Florence2Processor {
  (image: RawImage, prompts: string[]): Promise<Record<string, unknown>>;
  construct_prompts(text: string): string[];
  batch_decode(ids: unknown, opts: { skip_special_tokens: boolean }): string[];
  post_process_generation(text: string, task: string, size: [number, number]): Record<string, unknown>;
}

export async function loadFlorence(dtype: DtypeMap, device: DeviceMap = 'cpu', sessionOptions?: Record<string, unknown>): Promise<Florence> {
  env.localModelPath = path.join(os.homedir(), '.shoots', 'models');
  env.allowRemoteModels = false;
  const model = await Florence2ForConditionalGeneration.from_pretrained(MODEL_ID, { dtype, device, ...(sessionOptions ? { session_options: sessionOptions } : {}) });
  const processor = (await AutoProcessor.from_pretrained(MODEL_ID)) as unknown as Florence2Processor;
  const generate = async (image: RawImage, task: string, text = ''): Promise<string> => {
    const inputs = await processor(image, processor.construct_prompts(task + text));
    const ids = await model.generate({ ...inputs, max_new_tokens: 256 } as never);
    return processor.batch_decode(ids, { skip_special_tokens: false })[0] as string;
  };
  return {
    async caption(image) {
      const task = '<MORE_DETAILED_CAPTION>';
      return processor.post_process_generation(await generate(image, task), task, image.size)[task] as string;
    },
    async ground(image, phrases) {
      const task = '<CAPTION_TO_PHRASE_GROUNDING>';
      const out = await generate(image, task, phrases.map((p) => `${p}.`).join(' '));
      return processor.post_process_generation(out, task, image.size)[task] as { labels: string[]; bboxes: number[][] };
    },
    async segment(image, phrase) {
      return parsePolygons(await generate(image, '<REFERRING_EXPRESSION_SEGMENTATION>', phrase), image.width, image.height);
    },
  };
}

/**
 * `<loc_x><loc_y>…` pairs to pixel polygons; `<sep>` splits several.
 *
 * Coordinates are quantised to 1000 bins over each axis, the bin centre is the
 * value.
 */
export function parsePolygons(raw: string, width: number, height: number): number[][] {
  return raw
    .split('<sep>')
    .map((part) => {
      const locs = [...part.matchAll(/<loc_(\d+)>/g)].map((m) => Number(m[1]));
      const poly: number[] = [];
      for (let i = 0; i + 1 < locs.length; i += 2) poly.push(((locs[i]! + 0.5) / 1000) * width, ((locs[i + 1]! + 0.5) / 1000) * height);
      return poly;
    })
    .filter((p) => p.length >= 6);
}

/** Rasterise polygons onto a w×h grid (even–odd rule) — enough to compare masks. */
export function rasterise(polys: number[][], width: number, height: number, w = 96, h = 96): Uint8Array {
  const mask = new Uint8Array(w * h);
  for (let gy = 0; gy < h; gy++) {
    const y = ((gy + 0.5) / h) * height;
    for (let gx = 0; gx < w; gx++) {
      const x = ((gx + 0.5) / w) * width;
      let inside = false;
      for (const p of polys) {
        for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
          const [xi, yi, xj, yj] = [p[i]!, p[i + 1]!, p[j]!, p[j + 1]!];
          if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
      }
      mask[gy * w + gx] = inside ? 1 : 0;
    }
  }
  return mask;
}

/** The RAW's embedded preview, upright, bounded to `size`. */
export async function loadUpright(file: string, size = 768): Promise<{ image: RawImage; jpeg: Buffer }> {
  const { buffer } = await loadRenderableImage(file);
  const rot = ({ 3: 180, 6: 90, 8: 270 } as Record<number, number>)[await readOrientation(file)] ?? 0;
  const jpeg = await sharp(buffer).rotate(rot).resize(size, size, { fit: 'inside' }).jpeg({ quality: 92 }).toBuffer();
  return { image: await RawImage.fromBlob(new Blob([jpeg])), jpeg };
}
