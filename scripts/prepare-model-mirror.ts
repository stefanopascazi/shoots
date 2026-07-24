/**
 * Builds the CLIP model archive that shoots downloads at runtime for the
 * `--model onnx` backend, and prints its SHA-256 to pin in clipManifest.ts.
 *
 * Output archive (files at the root):
 *   clip-image-encoder.onnx   ONNX CLIP ViT-B/32 image encoder (image_embeds)
 *   keywords.json             curated vocabulary with precomputed CLIP text
 *                             embeddings (so runtime needs no text encoder)
 *   aesthetics.json           contrastive quality-aspect prompt embeddings for
 *                             zero-shot aesthetic scoring (composition, exposure,
 *                             subject, lighting, sharpness, storytelling)
 *
 * Source: Xenova/clip-vit-base-patch32 — ONNX weights of openai/clip-vit-base-
 * patch32 (MIT). The text embeddings are computed here, offline, with
 * @huggingface/transformers (a devDependency; never shipped).
 *
 * Usage:
 *   bun scripts/prepare-model-mirror.ts
 * This build adds aesthetics.json, so it is a NEW archive revision. After
 * building: upload dist-models/clip-<MODEL_VERSION>.tar.gz to the `models-v1`
 * release, then in clipManifest.ts bump CLIP_MODEL_VERSION to MODEL_VERSION and
 * paste the printed checksum into SHA256. Until then the shipped archive has no
 * aesthetics.json and the onnx backend falls back to the technical heuristic.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AutoTokenizer, CLIPTextModelWithProjection } from '@huggingface/transformers';

const MODEL_ID = 'Xenova/clip-vit-base-patch32';
const HF_BASE = `https://huggingface.co/${MODEL_ID}/resolve/main`;
/** Packaging revision (matches CLIP_MODEL_VERSION once this build goes live). */
const MODEL_VERSION = 'vit-b32-int8-2';
const ARCHIVE = `clip-${MODEL_VERSION}.tar.gz`;
/** CLIP logit scale for the zero-shot aesthetic softmax (openai/clip default). */
const AESTHETIC_TEMPERATURE = 100;

/**
 * Curated photography vocabulary. `label` is the keyword written to sidecars;
 * `prompt` is embedded as "a photo of <prompt>" (CLIP zero-shot convention).
 */
const VOCAB: { label: string; prompt: string }[] = [
  { label: 'portrait', prompt: 'a portrait of a person' },
  { label: 'group-photo', prompt: 'a group of people' },
  { label: 'candid', prompt: 'a candid photo of people' },
  { label: 'wedding', prompt: 'a wedding' },
  { label: 'landscape', prompt: 'a landscape' },
  { label: 'cityscape', prompt: 'a cityscape' },
  { label: 'architecture', prompt: 'a building or architecture' },
  { label: 'street', prompt: 'a street scene' },
  { label: 'wildlife', prompt: 'a wild animal' },
  { label: 'bird', prompt: 'a bird' },
  { label: 'pet', prompt: 'a pet cat or dog' },
  { label: 'nature', prompt: 'nature' },
  { label: 'forest', prompt: 'a forest' },
  { label: 'mountain', prompt: 'a mountain' },
  { label: 'beach', prompt: 'a beach' },
  { label: 'ocean', prompt: 'the ocean or sea' },
  { label: 'sunset', prompt: 'a sunset' },
  { label: 'night', prompt: 'a night scene' },
  { label: 'snow', prompt: 'snow' },
  { label: 'macro', prompt: 'a macro close-up' },
  { label: 'flower', prompt: 'a flower' },
  { label: 'food', prompt: 'a plate of food' },
  { label: 'sports', prompt: 'people playing sports' },
  { label: 'concert', prompt: 'a concert or live music' },
  { label: 'car', prompt: 'a car' },
  { label: 'boat', prompt: 'a boat' },
  { label: 'aerial', prompt: 'an aerial view from above' },
  { label: 'panorama', prompt: 'a wide panorama' },
  { label: 'black-and-white', prompt: 'a black and white photo' },
  { label: 'silhouette', prompt: 'a silhouette against the light' },
  { label: 'reflection', prompt: 'a reflection in water' },
  { label: 'indoor', prompt: 'an indoor scene' },
  { label: 'outdoor', prompt: 'an outdoor scene' },
];

/**
 * Quality aspects for zero-shot aesthetic scoring. Each is a contrastive pair:
 * the image is scored by how much closer it sits to `positive` than `negative`
 * in CLIP space. Together they cover the dimensions of a well-made photograph —
 * composition, exposure, subject, lighting, sharpness and storytelling — so the
 * aggregate is far richer than a single "good photo?" prompt. `weight` biases
 * the aggregate toward the dimensions that matter most for a keeper.
 */
const ASPECTS: { name: string; weight: number; positive: string; negative: string }[] = [
  {
    name: 'overall',
    weight: 1.5,
    positive: 'a high quality professional photograph',
    negative: 'a low quality amateur snapshot',
  },
  {
    name: 'composition',
    weight: 1.2,
    positive: 'a well composed photograph with balanced framing',
    negative: 'a poorly composed photograph with awkward framing',
  },
  {
    name: 'exposure',
    weight: 1,
    positive: 'a well exposed photograph with balanced light',
    negative: 'a badly exposed photograph, too dark or overexposed',
  },
  {
    name: 'subject',
    weight: 1.2,
    positive: 'a photograph with a clear compelling subject',
    negative: 'a cluttered photograph with no clear subject',
  },
  {
    name: 'sharpness',
    weight: 1,
    positive: 'a sharp photograph in crisp focus',
    negative: 'a blurry out of focus photograph',
  },
  {
    name: 'lighting',
    weight: 1,
    positive: 'a photograph with beautiful lighting',
    negative: 'a photograph with flat dull lighting',
  },
  {
    name: 'storytelling',
    weight: 1,
    positive: 'an evocative photograph that tells a story',
    negative: 'a boring uninteresting photograph',
  },
];

const repoRoot = path.resolve(import.meta.dir, '..');
const workDir = path.join(repoRoot, 'dist-models', '.work');
const outDir = path.join(repoRoot, 'dist-models');

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed ${res.status}: ${url}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
}

type TextEncoder = (prompts: string[]) => Promise<{ embeddings: number[][]; dim: number }>;

/** Load the CLIP text encoder once and return a batch-embedding function. */
async function loadTextEncoder(): Promise<TextEncoder> {
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
  const text = await CLIPTextModelWithProjection.from_pretrained(MODEL_ID, { dtype: 'int8' });
  return async (prompts: string[]) => {
    const inputs = tokenizer(prompts, { padding: true, truncation: true });
    const { text_embeds } = (await text(inputs)) as { text_embeds: { data: number[]; dims: number[] } };
    const dim = text_embeds.dims[1];
    const data = Array.from(text_embeds.data as ArrayLike<number>);
    const embeddings = prompts.map((_, i) =>
      // Round to 6 decimals — plenty for cosine ranking, ~halves the JSON size.
      data.slice(i * dim, (i + 1) * dim).map((x) => Math.round(x * 1e6) / 1e6),
    );
    return { embeddings, dim };
  };
}

async function computeKeywordEmbeddings(encode: TextEncoder): Promise<{ dim: number; keywords: { label: string; embedding: number[] }[] }> {
  const { embeddings, dim } = await encode(VOCAB.map((v) => `a photo of ${v.prompt}`));
  return { dim, keywords: VOCAB.map((v, i) => ({ label: v.label, embedding: embeddings[i] })) };
}

async function computeAestheticEmbeddings(
  encode: TextEncoder,
): Promise<{ dim: number; aspects: { name: string; weight: number; positive: number[]; negative: number[] }[] }> {
  // One batch: all positive prompts followed by all negative prompts.
  const prompts = [...ASPECTS.map((a) => a.positive), ...ASPECTS.map((a) => a.negative)];
  const { embeddings, dim } = await encode(prompts);
  const n = ASPECTS.length;
  return {
    dim,
    aspects: ASPECTS.map((a, i) => ({
      name: a.name,
      weight: a.weight,
      positive: embeddings[i],
      negative: embeddings[n + i],
    })),
  };
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function main(): Promise<void> {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  console.error('↓ downloading CLIP image encoder (vision_model_int8.onnx)...');
  await download(`${HF_BASE}/onnx/vision_model_int8.onnx`, path.join(workDir, 'clip-image-encoder.onnx'));

  console.error('· loading CLIP text encoder (offline)...');
  const encode = await loadTextEncoder();

  console.error('· computing keyword text embeddings...');
  const { dim, keywords } = await computeKeywordEmbeddings(encode);
  await writeFile(
    path.join(workDir, 'keywords.json'),
    JSON.stringify({ model: MODEL_ID, dim, keywords }),
    'utf8',
  );

  console.error('· computing aesthetic aspect embeddings...');
  const aesthetics = await computeAestheticEmbeddings(encode);
  await writeFile(
    path.join(workDir, 'aesthetics.json'),
    JSON.stringify({ model: MODEL_ID, dim: aesthetics.dim, temperature: AESTHETIC_TEMPERATURE, aspects: aesthetics.aspects }),
    'utf8',
  );

  // Stream tar to stdout → file. A drive-letter path passed to `tar -f` is
  // misread as host:path on Windows, so never pass the output as an arg.
  const outPath = path.join(outDir, ARCHIVE);
  await new Promise<void>((resolve, reject) => {
    const fh = createWriteStream(outPath);
    const child = spawn('tar', ['-cz', '-C', workDir, 'clip-image-encoder.onnx', 'keywords.json', 'aesthetics.json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const err: Buffer[] = [];
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.stdout.pipe(fh);
    child.on('error', reject);
    fh.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${Buffer.concat(err).toString().trim()}`)),
    );
  });

  await rm(workDir, { recursive: true, force: true });
  const digest = await sha256(outPath);
  console.error(`\n✓ built ${outPath}`);
  console.log(`sha256 = ${digest}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
