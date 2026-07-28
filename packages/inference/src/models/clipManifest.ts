/**
 * Manifest for the ONNX CLIP model used by the `onnx` quality backend.
 *
 * Unlike exiftool, model archives are platform-independent: the `.onnx` weights
 * run on any OS through onnxruntime-node (only the runtime itself is native), so
 * there is no per-platform split — a single archive serves every platform.
 *
 * The archive is repackaged (see scripts/prepare-model-mirror.ts) into a
 * normalized `.tar.gz` and hosted on our own GitHub release; the payload is
 * pinned to a verified SHA-256. The generic download → verify → extract → mark
 * machinery is `@shoots/core`'s `provisionArchive`.
 */
import path from 'node:path';
import { modelDir, provisionArchive, isProvisioned, normalizeSha256 } from '@shoots/core';

/**
 * Model identity + our packaging revision. Bump when the archive contents change
 * so a fresh install dir is used and existing installs re-provision.
 *
 * `int8-2` adds aesthetics.json, switching the aesthetic score from the technical
 * heuristic fallback to zero-shot CLIP over quality aspects. Built by
 * scripts/prepare-model-mirror.ts — the archive must be uploaded to the
 * `models-v1` release for runtime provisioning to succeed.
 */
export const CLIP_MODEL_VERSION = 'vit-b32-int8-2';

/** CLIP ViT-B/32 image preprocessing parameters (from preprocessor_config.json). */
export const CLIP_INPUT = {
  size: 224,
  mean: [0.48145466, 0.4578275, 0.40821073] as [number, number, number],
  std: [0.26862954, 0.26130258, 0.27577711] as [number, number, number],
  /** Projected embedding dimension. */
  dim: 512,
} as const;

/** GitHub release tag that hosts the repackaged model archives. */
export const MODELS_RELEASE = 'models-v1';

/**
 * Base URL for model archives. Override with SHOOTS_MODELS_BASEURL for CI, a
 * private mirror, or local testing — including a `file://` URL pointing at a
 * local build, so provisioning can be exercised without a published release.
 */
const MIRROR_BASE =
  process.env.SHOOTS_MODELS_BASEURL ??
  `https://github.com/stefanopascazi/shoots/releases/download/${MODELS_RELEASE}`;

const ARCHIVE = `clip-${CLIP_MODEL_VERSION}.tar.gz`;

// SHA-256 of the archive produced by scripts/prepare-model-mirror.ts. gzip is
// not deterministic across rebuilds, so upload the built dist-models/ file as-is
// to the `models-v1` release rather than regenerating it.
const SHA256 = '499783345892c111950d08484acef46314374462bf5797374944fc043ff39505';

/** File names inside the extracted archive. */
const IMAGE_ENCODER = 'clip-image-encoder.onnx';
const VOCAB = 'keywords.json';
const AESTHETICS = 'aesthetics.json';

export interface ResolvedModelManifest {
  version: string;
  url: string;
  sha256: string;
  installDir: string;
  /** ONNX CLIP image encoder (image → embedding). */
  imageEncoderPath: string;
  /** Zero-shot keyword vocabulary (curated, user-extensible). */
  vocabPath: string;
  /**
   * Zero-shot aesthetic prompt embeddings. Optional: older archives predate it,
   * so consumers must tolerate the file being absent (technical fallback).
   */
  aestheticsPath: string;
}

export function clipModelManifest(): ResolvedModelManifest {
  const installDir = modelDir('clip', CLIP_MODEL_VERSION);
  return {
    version: CLIP_MODEL_VERSION,
    url: `${MIRROR_BASE}/${ARCHIVE}`,
    sha256: normalizeSha256(SHA256),
    installDir,
    imageEncoderPath: path.join(installDir, IMAGE_ENCODER),
    vocabPath: path.join(installDir, VOCAB),
    aestheticsPath: path.join(installDir, AESTHETICS),
  };
}

export class ModelMirrorNotConfiguredError extends Error {}

const SHA256_RE = /^[0-9a-f]{64}$/;

export interface EnsureModelOptions {
  onStatus?: (message: string) => void;
  onProgress?: (received: number, total: number | null) => void;
}

/**
 * Synchronous, hot-path resolution. Never touches the network. Returns null
 * when the model still needs to be provisioned.
 */
export function resolveClipModel(): ResolvedModelManifest | null {
  const m = clipModelManifest();
  return isProvisioned(m.installDir) ? m : null;
}

/**
 * Provision the CLIP model if missing: download → verify sha256 → extract →
 * mark. Idempotent and race-safe. Throws ModelMirrorNotConfiguredError until the
 * mirror is built and its checksum pinned.
 */
export async function ensureClipModel(options: EnsureModelOptions = {}): Promise<ResolvedModelManifest> {
  const m = clipModelManifest();
  if (isProvisioned(m.installDir)) return m;

  if (!SHA256_RE.test(m.sha256)) {
    throw new ModelMirrorNotConfiguredError(
      `CLIP model ${m.version} has no pinned checksum yet. Build and upload the model ` +
        `mirror, then fill sha256 in clipManifest.ts (see scripts/prepare-model-mirror.ts).`,
    );
  }

  await provisionArchive({
    installDir: m.installDir,
    url: m.url,
    sha256: m.sha256,
    label: `CLIP model ${m.version}`,
    onStatus: options.onStatus,
    onProgress: options.onProgress,
  });
  return m;
}
