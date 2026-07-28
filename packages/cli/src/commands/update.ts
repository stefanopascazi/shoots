/**
 * shoots update [--check]
 *
 * Self-update for the standalone binary: query the latest GitHub release,
 * compare it to the running version and, if newer, download the matching
 * per-platform asset, verify it against the release SHA256SUMS.txt, and swap it
 * in place. `--check` only reports availability. Running from un-built sources
 * (node/bun) is refused — there is nothing to replace.
 */
import { chmod, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { compareSemver, downloadFile } from '@shoots/core';
import { logError, makeIo, printHuman, printJson } from '../io.js';
import { VERSION } from '../version.js';

const REPO = process.env.SHOOTS_REPO ?? 'stefanopascazi/shoots';

interface UpdateOptions {
  check?: boolean;
  json?: boolean;
  verbose?: boolean;
}

interface GithubAsset {
  name: string;
  browser_download_url: string;
}
interface GithubRelease {
  tag_name: string;
  assets: GithubAsset[];
}

export function registerUpdateCommand(program: Command): void {
  program
    .command('update')
    .description('Check for a newer release and update the standalone binary in place')
    .option('--check', 'only report whether an update is available, without installing')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runUpdate);
}

/** Map the current platform/arch to the release asset target id. */
function currentTarget(): string | null {
  const key = `${process.platform}/${process.arch}`;
  const map: Record<string, string> = {
    'win32/x64': 'windows-x64',
    'linux/x64': 'linux-x64',
    'linux/arm64': 'linux-arm64',
    // Intel macOS (darwin/x64) is intentionally not built — no reliable Intel CI
    // runner; the Bun binary embeds per-arch native addons (no universal build).
    'darwin/arm64': 'darwin-arm64',
  };
  return map[key] ?? null;
}

const ghHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {
    'User-Agent': 'shoots-updater',
    Accept: 'application/vnd.github+json',
  };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
};

/** Extract the expected digest for `name` from a sha256sum-format listing. */
function shaFromSums(text: string, name: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m && m[2] === name) return m[1].toLowerCase();
  }
  return null;
}

async function runUpdate(options: UpdateOptions): Promise<void> {
  const io = makeIo(options);

  let release: GithubRelease;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: ghHeaders(),
    });
    if (res.status === 404) {
      printHuman(io, 'No published releases yet.');
      if (io.json) printJson({ command: 'update', current: VERSION, latest: null, hasUpdate: false });
      return;
    }
    if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}`);
    release = (await res.json()) as GithubRelease;
  } catch (err) {
    logError(`Could not check for updates: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const latest = release.tag_name;
  const hasUpdate = compareSemver(latest, VERSION) > 0;

  if (io.json && (options.check || !hasUpdate)) {
    printJson({ command: 'update', current: VERSION, latest, hasUpdate });
  }
  if (!hasUpdate) {
    printHuman(io, `Up to date (v${VERSION}).`);
    return;
  }
  printHuman(io, `Update available: v${VERSION} → ${latest}`);
  if (options.check) return;

  // ---- install ----
  const exe = process.execPath;
  if (/[\\/](node|bun)(\.exe)?$/i.test(exe)) {
    logError('`shoots update` only works on the standalone binary, not when run via node/bun.');
    process.exitCode = 2;
    return;
  }
  const target = currentTarget();
  if (!target) {
    logError(`No release asset for this platform (${process.platform}/${process.arch}).`);
    process.exitCode = 1;
    return;
  }

  const isWin = process.platform === 'win32';
  const assetName = `shoots-${target}${isWin ? '.exe' : ''}`;
  const asset = release.assets.find((a) => a.name === assetName);
  const sums = release.assets.find((a) => a.name === 'SHA256SUMS.txt');
  if (!asset || !sums) {
    logError(`Release ${latest} is missing ${!asset ? assetName : 'SHA256SUMS.txt'}.`);
    process.exitCode = 1;
    return;
  }

  try {
    const sumsText = await (await fetch(sums.browser_download_url, { headers: ghHeaders() })).text();
    const sha256 = shaFromSums(sumsText, assetName);
    if (!sha256) throw new Error(`no checksum for ${assetName} in SHA256SUMS.txt`);

    const dir = path.dirname(exe);
    const staged = path.join(dir, `.shoots-update-${process.pid}${isWin ? '.exe' : ''}`);
    let lastPct = -1;
    await downloadFile(asset.browser_download_url, staged, {
      sha256,
      onProgress: (received, total) => {
        if (io.json || !total) return;
        const pct = Math.floor((received / total) * 100);
        if (pct === lastPct) return;
        lastPct = pct;
        process.stderr.write(`\r  ${pct}%${received >= total ? '\n' : ''}`);
      },
    });

    await swapBinary(exe, staged, isWin);

    printHuman(io, `Updated to ${latest}. Restart shoots to run the new version.`);
    if (io.json) printJson({ command: 'update', current: VERSION, latest, hasUpdate: true, installed: true });
  } catch (err) {
    logError(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

/**
 * Replace the running executable with the freshly downloaded one. On Unix the
 * rename is atomic even while the file is executing. On Windows a running exe
 * cannot be overwritten but CAN be renamed aside, so we move it to `.old`
 * (cleaned up best-effort — it stays locked until this process exits).
 */
async function swapBinary(exe: string, staged: string, isWin: boolean): Promise<void> {
  if (isWin) {
    const old = `${exe}.old`;
    await rm(old, { force: true }).catch(() => {});
    await rename(exe, old);
    await rename(staged, exe);
    await rm(old, { force: true }).catch(() => {});
  } else {
    await chmod(staged, 0o755);
    await rename(staged, exe);
  }
}
