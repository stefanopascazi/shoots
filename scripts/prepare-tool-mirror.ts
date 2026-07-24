/**
 * Repackages official exiftool distributions into the normalized `.tar.gz`
 * archives that shoots downloads at runtime, and prints their SHA-256 so they
 * can be pinned in packages/imaging/src/tools/exiftoolManifest.ts.
 *
 * Output layout inside each archive (files at the root):
 *   win32 : exiftool.exe + exiftool_files/
 *   unix  : exiftool     + lib/
 *
 * Source: the official exiftool distributions on SourceForge (exiftool.org no
 * longer self-hosts the files — it links out to SourceForge). We fetch from
 * SF's direct-download mirror host, which serves the file without the HTML
 * interstitial that the sourceforge.net/.../download links return.
 *
 * Usage (run on a machine whose `tar` is bsdtar for --platform win32, i.e.
 * Windows 10+ or macOS; any tar works for unix):
 *   bun scripts/prepare-tool-mirror.ts --platform win32 --version 13.59
 *   bun scripts/prepare-tool-mirror.ts --platform unix  --version 13.59
 *
 * Then upload dist-tools/*.tar.gz to the GitHub release `tools-v1`, paste the
 * printed checksums into the manifest, and set OWNER/REPO there.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const args = process.argv.slice(2);
const argValue = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const platform = argValue('--platform'); // 'win32' | 'unix'
const version = argValue('--version');
if ((platform !== 'win32' && platform !== 'unix') || !version) {
  console.error('usage: bun scripts/prepare-tool-mirror.ts --platform win32|unix --version <x.y>');
  process.exit(2);
}

const repoRoot = path.resolve(import.meta.dir, '..');
const workDir = path.join(repoRoot, 'dist-tools', `.work-${platform}`);
const outDir = path.join(repoRoot, 'dist-tools');

function run(cmd: string, cmdArgs: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    const err: Buffer[] = [];
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${Buffer.concat(err).toString().trim()}`)),
    );
  });
}

/** SourceForge direct-download mirror host (serves the raw file, no interstitial). */
const SF_MIRROR = 'https://master.dl.sourceforge.net/project/exiftool';

async function download(url: string, dest: string): Promise<void> {
  // A browser-like UA: some mirrors reject unknown/empty agents.
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'curl/8' } });
  if (!res.ok || !res.body) throw new Error(`download failed ${res.status}: ${url}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await readFile(file));
  return hash.digest('hex');
}

async function main(): Promise<void> {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  const staged = path.join(workDir, 'staged'); // normalized root to be archived
  await mkdir(staged, { recursive: true });

  if (platform === 'win32') {
    const url = `${SF_MIRROR}/exiftool-${version}_64.zip`;
    const zip = path.join(workDir, 'src.zip');
    console.error(`↓ ${url}`);
    await download(url, zip);
    // bsdtar (Windows 10+/macOS) extracts zip transparently.
    await run('tar', ['-xf', zip, '-C', workDir]);
    // Recent Windows builds wrap everything in a top-level `exiftool-<v>_64/`
    // folder; older ones extracted `exiftool(-k).exe` + `exiftool_files/` at
    // the root. Support both by locating the dir that holds exiftool_files.
    const wrapped = path.join(workDir, `exiftool-${version}_64`);
    const srcRoot = existsSync(path.join(wrapped, 'exiftool_files')) ? wrapped : workDir;
    const entries = await readdir(srcRoot, { withFileTypes: true });
    const exe = entries.find((e) => e.isFile() && /^exiftool.*\.exe$/i.test(e.name));
    if (!exe) throw new Error('exiftool exe not found in extracted zip');
    // Renaming away the `(-k)` suffix disables the "keep window open" pause.
    await rename(path.join(srcRoot, exe.name), path.join(staged, 'exiftool.exe'));
    if (!existsSync(path.join(srcRoot, 'exiftool_files'))) throw new Error('exiftool_files/ missing');
    await rename(path.join(srcRoot, 'exiftool_files'), path.join(staged, 'exiftool_files'));
    // Ship the readme (license lives in exiftool_files/) for compliance.
    if (existsSync(path.join(srcRoot, 'README.txt'))) {
      await rename(path.join(srcRoot, 'README.txt'), path.join(staged, 'README.txt'));
    }
  } else {
    const url = `${SF_MIRROR}/Image-ExifTool-${version}.tar.gz`;
    const tgz = path.join(workDir, 'src.tar.gz');
    console.error(`↓ ${url}`);
    await download(url, tgz);
    await run('tar', ['-xzf', tgz, '-C', workDir]);
    const dir = path.join(workDir, `Image-ExifTool-${version}`);
    await rename(path.join(dir, 'exiftool'), path.join(staged, 'exiftool'));
    await rename(path.join(dir, 'lib'), path.join(staged, 'lib'));
    // Ship the license alongside the tool (redistribution compliance).
    for (const legal of ['README', 'Changes']) {
      if (existsSync(path.join(dir, legal))) {
        await rename(path.join(dir, legal), path.join(staged, legal));
      }
    }
  }

  const outName = `exiftool-${version}-${platform}.tar.gz`;
  const outPath = path.join(outDir, outName);
  await run('tar', ['-czf', outPath, '-C', staged, '.']);
  await rm(workDir, { recursive: true, force: true });

  const digest = await sha256(outPath);
  console.error(`\n✓ built ${outPath}`);
  console.log(`${platform}: sha256 = ${digest}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
