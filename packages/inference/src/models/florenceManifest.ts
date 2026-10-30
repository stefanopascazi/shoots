/**
 * Manifest for Florence-2, the vision model behind keywords and region intents.
 *
 * Optional by design: 630 MB compressed, so it is never part of the default
 * `shoots setup`. It is provisioned on first use of a feature that needs it, or
 * up front with `shoots setup --vision`. Same machinery as CLIP: one
 * platform-independent archive on our own release, pinned to a SHA-256, built by
 * scripts/prepare-florence-mirror.ts.
 */
import path from 'node:path';
import { isProvisioned, modelDir, normalizeSha256, provisionArchive } from '@shoots/core';
import { ModelMirrorNotConfiguredError, MODELS_RELEASE, type EnsureModelOptions } from './clipManifest.js';

/** Packaging revision; bump with any change to the archive's contents. */
export const FLORENCE_MODEL_VERSION = 'base-ft-fp32-1';

const MIRROR_BASE =
  process.env.SHOOTS_MODELS_BASEURL ?? `https://github.com/stefanopascazi/shoots/releases/download/${MODELS_RELEASE}`;
const ARCHIVE = `florence-${FLORENCE_MODEL_VERSION}.tar.gz`;
// From scripts/prepare-florence-mirror.ts; gzip is not reproducible, so upload the built file as-is.
const SHA256 = '969d4c931a89eb5ccf901a98bcc3994eaae27a91642517f530958b57b56f1774';

export interface ResolvedFlorenceManifest {
  version: string;
  url: string;
  sha256: string;
  /** Holds tokenizer.json and onnx/ — what loadFlorence() takes. */
  installDir: string;
}

export function florenceManifest(): ResolvedFlorenceManifest {
  return {
    version: FLORENCE_MODEL_VERSION,
    url: `${MIRROR_BASE}/${ARCHIVE}`,
    sha256: normalizeSha256(SHA256),
    installDir: modelDir('florence', FLORENCE_MODEL_VERSION),
  };
}

/** Hot-path resolution: never touches the network; null until provisioned. */
export function resolveFlorenceModel(): ResolvedFlorenceManifest | null {
  const m = florenceManifest();
  return isProvisioned(m.installDir) ? m : null;
}

/** Provision Florence-2 if missing: download → verify → extract → mark. Idempotent. */
export async function ensureFlorenceModel(options: EnsureModelOptions = {}): Promise<ResolvedFlorenceManifest> {
  const m = florenceManifest();
  if (isProvisioned(m.installDir)) return m;
  if (!/^[0-9a-f]{64}$/.test(m.sha256)) {
    throw new ModelMirrorNotConfiguredError(`Florence-2 ${m.version} has no pinned checksum yet (see scripts/prepare-florence-mirror.ts)`);
  }
  await provisionArchive({
    installDir: m.installDir,
    url: m.url,
    sha256: m.sha256,
    label: `vision model ${m.version} (${path.basename(m.url)})`,
    onStatus: options.onStatus,
    onProgress: options.onProgress,
  });
  return m;
}
