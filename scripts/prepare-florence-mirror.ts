/**
 * Builds the Florence-2 archive shoots downloads on first use of the vision
 * features (keywords, region intents), and prints its SHA-256 to pin in
 * packages/inference/src/models/florenceManifest.ts.
 *
 * Output archive:
 *   tokenizer.json            byte-level BPE vocabulary + task/location tokens
 *   onnx/vision_encoder.onnx  fp32, image → features
 *   onnx/embed_tokens.onnx    fp32, ids → embeddings
 *   onnx/encoder_model.onnx   fp32
 *   onnx/decoder_model_merged.onnx  fp32, with and without cache in one graph
 *   LICENSE                   Microsoft's MIT notice, which travels with the weights
 *
 * Source: onnx-community/Florence-2-base-ft at a pinned revision — the ONNX
 * export of microsoft/Florence-2-base-ft (MIT). fp32 because the quantised
 * exports moved segmentation masks too far from fp32 (mask IoU 0.62, measured
 * with tools/florence-probe/bench.ts).
 *
 * Usage:
 *   bun scripts/prepare-florence-mirror.ts [--from <dir with the same layout>]
 * then upload dist-models/florence-<MODEL_VERSION>.tar.gz to the `models-v1`
 * release and paste the printed checksum into florenceManifest.ts.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const REPO = 'onnx-community/Florence-2-base-ft';
const REVISION = 'e88a44eaf3791a35eae0c5a47b3dbcd36e67eb6f';
const LICENSE_URL = 'https://huggingface.co/microsoft/Florence-2-base-ft/raw/f6c1a25888ffc1d945ee8a1a77ac833c7303d46e/LICENSE';
/** Must match FLORENCE_MODEL_VERSION in florenceManifest.ts. */
const MODEL_VERSION = 'base-ft-fp32-1';
const FILES = ['tokenizer.json', 'onnx/vision_encoder.onnx', 'onnx/embed_tokens.onnx', 'onnx/encoder_model.onnx', 'onnx/decoder_model_merged.onnx'];

const repoRoot = path.resolve(import.meta.dir, '..');
const workDir = path.join(repoRoot, 'dist-models', '.work-florence');
const outDir = path.join(repoRoot, 'dist-models');

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`GET ${url} → ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

async function main(): Promise<void> {
  const fromIdx = process.argv.indexOf('--from');
  const from = fromIdx >= 0 ? process.argv[fromIdx + 1] : undefined;
  await rm(workDir, { recursive: true, force: true });
  await mkdir(path.join(workDir, 'onnx'), { recursive: true });
  await mkdir(outDir, { recursive: true });

  for (const f of FILES) {
    const dest = path.join(workDir, f);
    if (from && existsSync(path.join(from, f))) {
      console.error(`· copying ${f}`);
      await copyFile(path.join(from, f), dest);
    } else {
      console.error(`↓ downloading ${f}`);
      await download(`https://huggingface.co/${REPO}/resolve/${REVISION}/${f}`, dest);
    }
  }
  console.error('↓ LICENSE');
  const license = await fetch(LICENSE_URL);
  if (!license.ok) throw new Error(`GET ${LICENSE_URL} → ${license.status}`);
  await writeFile(path.join(workDir, 'LICENSE'), await license.text(), 'utf8');

  // Stream tar to stdout → file: a drive-letter path given to `tar -f` is read as host:path on Windows.
  const outPath = path.join(outDir, `florence-${MODEL_VERSION}.tar.gz`);
  await new Promise<void>((resolve, reject) => {
    const fh = createWriteStream(outPath);
    const child = spawn('tar', ['-cz', '-C', workDir, 'LICENSE', ...FILES], { stdio: ['ignore', 'pipe', 'pipe'] });
    const err: Buffer[] = [];
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.stdout.pipe(fh);
    child.on('error', reject);
    fh.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${Buffer.concat(err).toString().trim()}`))));
  });
  await rm(workDir, { recursive: true, force: true });
  console.error(`\n✓ built ${outPath}`);
  console.log(`sha256 = ${await sha256(outPath)}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
