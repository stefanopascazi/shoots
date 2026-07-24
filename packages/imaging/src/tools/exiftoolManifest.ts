/**
 * Per-platform manifest describing which exiftool build to fetch and how to run
 * it. Archives are repackaged (see scripts/prepare-tool-mirror.ts) into a
 * normalized `.tar.gz` and hosted on our own GitHub release, so URLs are stable
 * and every payload is pinned to a verified SHA-256.
 *
 *   - Windows: the official standalone (`exiftool.exe` + `exiftool_files/`),
 *     self-contained, no Perl required.
 *   - macOS / Linux: the ExifTool Perl distribution (`exiftool` + `lib/`),
 *     invoked through the system Perl interpreter.
 */
import path from 'node:path';
import { toolDir } from '@shoots/core';

export const EXIFTOOL_VERSION = '13.59';

/** GitHub release tag that hosts the repackaged tool archives. */
export const TOOLS_RELEASE = 'tools-v1';

/**
 * Base URL for the tool archives. Override with SHOOTS_TOOLS_BASEURL for CI, a
 * private mirror, or local testing — including a `file://` URL pointing at a
 * local `dist-tools/` build, so provisioning can be exercised without a release.
 */
const MIRROR_BASE =
  process.env.SHOOTS_TOOLS_BASEURL ??
  `https://github.com/stefanopascazi/shoots/releases/download/${TOOLS_RELEASE}`;

export interface ExiftoolPlatformSpec {
  /** Archive file name on the mirror. */
  archive: string;
  /** Lowercase hex SHA-256 of the archive. Empty until the mirror is built. */
  sha256: string;
  /** Runnable path relative to the extracted install dir. */
  bin: string;
  /** Whether `bin` must be invoked through the system Perl interpreter. */
  viaPerl: boolean;
}

// SHA-256 of the repackaged archives produced by scripts/prepare-tool-mirror.ts
// for EXIFTOOL_VERSION. These must match the exact files uploaded to the
// `tools-v1` release — gzip is not deterministic across rebuilds, so upload the
// built dist-tools/ files as-is rather than regenerating them.
const SPECS: Record<string, ExiftoolPlatformSpec | undefined> = {
  win32: {
    archive: `exiftool-${EXIFTOOL_VERSION}-win32.tar.gz`,
    sha256: '6ce38d90c460cf23c8cd17fe33eb1dd224115eceba4526342aab410fcc42991e',
    bin: 'exiftool.exe',
    viaPerl: false,
  },
  darwin: {
    archive: `exiftool-${EXIFTOOL_VERSION}-unix.tar.gz`,
    sha256: '617e6715a44e8a970731b135eb1d28e0250f7c7832253da9d8058096f4cb70c5',
    bin: 'exiftool',
    viaPerl: true,
  },
  linux: {
    archive: `exiftool-${EXIFTOOL_VERSION}-unix.tar.gz`,
    sha256: '617e6715a44e8a970731b135eb1d28e0250f7c7832253da9d8058096f4cb70c5',
    bin: 'exiftool',
    viaPerl: true,
  },
};

export interface ResolvedExiftoolManifest {
  version: string;
  url: string;
  sha256: string;
  installDir: string;
  binPath: string;
  viaPerl: boolean;
}

export class UnsupportedPlatformError extends Error {}

export function exiftoolManifest(platform: string = process.platform): ResolvedExiftoolManifest {
  const spec = SPECS[platform];
  if (!spec) {
    throw new UnsupportedPlatformError(`No exiftool build is configured for platform "${platform}"`);
  }
  const installDir = toolDir('exiftool', EXIFTOOL_VERSION);
  return {
    version: EXIFTOOL_VERSION,
    url: `${MIRROR_BASE}/${spec.archive}`,
    sha256: spec.sha256,
    installDir,
    binPath: path.join(installDir, spec.bin),
    viaPerl: spec.viaPerl,
  };
}
