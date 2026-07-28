/**
 * Per-platform manifest for the LibRaw `dcraw_emu` binary — the neutral
 * RAW-developer baseline used by `shoots develop export --baseline external`.
 *
 * Unlike exiftool (a Perl distribution that runs anywhere), LibRaw is a native
 * C++ program, so every platform/arch needs its own build. We cross-build
 * `dcraw_emu` from a pinned LibRaw source in CI (see .github/workflows/
 * libraw-mirror.yml), statically linked for portability, repackage it into a
 * normalized `.tar.gz` with the executable at the archive root, and host it on
 * the same tools release as exiftool. macOS ships a single universal2
 * (arm64 + x86_64) binary; Linux and Windows are per-arch.
 *
 * Licensing: LibRaw is dual-licensed LGPL-2.1 / CDDL-1.0. We redistribute the
 * compiled binary under CDDL-1.0 (which — unlike LGPL for a static binary — has
 * no relink obligation) and publish the exact LibRaw source we built from beside
 * the archives to satisfy CDDL's source-availability requirement. Running it as
 * a separate process keeps it cleanly isolated from our own code.
 */
import path from 'node:path';
import { toolDir } from '@shoots/core';
import { UnsupportedPlatformError } from './exiftoolManifest.js';

export const LIBRAW_VERSION = '0.21.5';

/** GitHub release tag hosting the repackaged tool archives (shared with exiftool). */
export const TOOLS_RELEASE = 'tools-v1';

/**
 * Base URL for the tool archives. Override with SHOOTS_TOOLS_BASEURL (shared
 * with exiftool) for CI, a private mirror, or a local `file://` dist-tools/ build.
 */
const MIRROR_BASE =
  process.env.SHOOTS_TOOLS_BASEURL ??
  `https://github.com/stefanopascazi/shoots/releases/download/${TOOLS_RELEASE}`;

export interface LibrawPlatformSpec {
  /** Archive file name on the mirror. */
  archive: string;
  /** Lowercase hex SHA-256 of the archive. Empty until the mirror is built. */
  sha256: string;
  /** Runnable path relative to the extracted install dir. */
  bin: string;
}

const V = LIBRAW_VERSION;

// SHA-256 of the repackaged archives produced by the libraw-mirror CI workflow
// (scripts/prepare-libraw-mirror.ts). Empty until the mirror is built and the
// archives are uploaded to the `tools-v1` release; fill each in from the
// workflow's printed checksums. gzip is not deterministic — pin the exact files
// uploaded, do not regenerate.
const SPECS: Record<string, LibrawPlatformSpec | undefined> = {
  win32: { archive: `libraw-${V}-win32-x64.tar.gz`, sha256: 'sha256:3cd53277e987e7d3614a6a2e8c5d8d14ae72e1d214f704368a45afe1458e2ff1', bin: 'dcraw_emu.exe' },
  // A single universal2 binary covers both Apple Silicon and Intel Macs.
  darwin: { archive: `libraw-${V}-darwin-universal.tar.gz`, sha256: 'sha256:5340b6182304727ae3bc94a724b0e93b25036ffe8c89f40b3964185d2beb15cd', bin: 'dcraw_emu' },
  'linux-x64': { archive: `libraw-${V}-linux-x64.tar.gz`, sha256: 'sha256:330d778fbe98ede5e3d1d81921a44d667f78bf5805f500477b958a0a79f5378c', bin: 'dcraw_emu' },
  'linux-arm64': { archive: `libraw-${V}-linux-arm64.tar.gz`, sha256: 'sha256:7acd07ebd45d6d3f3908c4e4c1d9a4c34140ee288d6f315c1caea085c4b87d33', bin: 'dcraw_emu' },
};

/** Map (platform, arch) to a SPECS key — macOS is a single universal build. */
function specKey(platform: string, arch: string): string {
  if (platform === 'win32') return 'win32';
  if (platform === 'darwin') return 'darwin';
  return `${platform}-${arch}`;
}

export interface ResolvedLibrawManifest {
  version: string;
  url: string;
  sha256: string;
  installDir: string;
  binPath: string;
}

export function librawManifest(
  platform: string = process.platform,
  arch: string = process.arch,
): ResolvedLibrawManifest {
  const spec = SPECS[specKey(platform, arch)];
  if (!spec) {
    throw new UnsupportedPlatformError(`No LibRaw build is configured for platform "${platform}/${arch}"`);
  }
  // Install dir is per-tool-per-version; a given machine only ever installs its
  // own platform/arch archive there, so the shared path is safe across arches.
  const installDir = toolDir('libraw', LIBRAW_VERSION);
  return {
    version: LIBRAW_VERSION,
    url: `${MIRROR_BASE}/${spec.archive}`,
    sha256: spec.sha256,
    installDir,
    binPath: path.join(installDir, spec.bin),
  };
}
