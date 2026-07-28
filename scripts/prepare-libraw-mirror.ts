/**
 * Builds the LibRaw `dcraw_emu` binary from a pinned source and repackages it
 * into the normalized `.tar.gz` archive that shoots downloads at runtime, then
 * prints its SHA-256 so it can be pinned in
 * packages/imaging/src/tools/librawManifest.ts.
 *
 * Unlike exiftool (Perl — the source IS the runnable) LibRaw is native C++ and
 * has NO official prebuilt for macOS/Linux, so we compile it. This script runs
 * ON the target OS (one matrix leg per platform in .github/workflows/
 * libraw-mirror.yml) and auto-detects it. LibRaw's own `Makefile.dist` builds
 * the sample binaries with NO external dependencies — the simplest, most
 * portable, license-cleanest option (no libjpeg/lcms/jasper to redistribute).
 * A few lossy formats (Canon sRAW, lossy-JPEG DNG) won't decode without libjpeg;
 * that is acceptable for a neutral demosaic baseline.
 *
 * Output archive layout (files at the root):
 *   dcraw_emu[.exe]        the runnable
 *   libraw.dll             (Windows only — dcraw_emu.exe loads it from its dir)
 *   LICENSE.LGPL / LICENSE.CDDL / COPYRIGHT   LibRaw license + notices
 *   SOURCE.txt             exact source URL + version (CDDL source availability)
 *
 * Licensing: we redistribute under CDDL-1.0 and MUST publish the exact source we
 * built from. The workflow uploads `LibRaw-<version>.tar.gz` beside the archives;
 * SOURCE.txt records the pinned URL. See librawManifest.ts.
 *
 * Usage (run on the matching OS):
 *   bun scripts/prepare-libraw-mirror.ts --version 0.21.5           # native arch
 *   bun scripts/prepare-libraw-mirror.ts --version 0.21.5 --arch universal  # macOS
 * Then upload dist-tools/libraw-*.tar.gz (+ the LibRaw source tarball) to the
 * `tools-v1` release and paste the printed checksum into librawManifest.ts.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, createWriteStream } from 'node:fs';
import { mkdir, readFile, copyFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const args = process.argv.slice(2);
const argValue = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const version = argValue('--version');
if (!version) {
  console.error('usage: bun scripts/prepare-libraw-mirror.ts --version <x.y.z> [--arch x64|arm64|universal]');
  process.exit(2);
}

// The runner's OS decides how we build; --arch only labels the output archive
// (and, on macOS, requests a universal2 fat binary).
const os = process.platform; // 'win32' | 'darwin' | 'linux'
const arch = argValue('--arch') ?? (os === 'darwin' ? 'universal' : process.arch);

const repoRoot = path.resolve(import.meta.dir, '..');
const workDir = path.join(repoRoot, 'dist-tools', `.work-libraw-${os}-${arch}`);
const outDir = path.join(repoRoot, 'dist-tools');
const srcRoot = path.join(workDir, `LibRaw-${version}`);

/** Archive key must match librawManifest.ts SPECS. */
function archiveName(): string {
  if (os === 'win32') return `libraw-${version}-win32-x64.tar.gz`;
  if (os === 'darwin') return `libraw-${version}-darwin-universal.tar.gz`;
  return `libraw-${version}-linux-${arch}.tar.gz`;
}

function run(cmd: string, cmdArgs: string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${cmdArgs.join(' ')} exited ${code}`))));
  });
}

const SRC_URL = `https://www.libraw.org/data/LibRaw-${version}.tar.gz`;

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'curl/8' } });
  if (!res.ok || !res.body) throw new Error(`download failed ${res.status}: ${url}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await readFile(file));
  return hash.digest('hex');
}

/** Build dcraw_emu from source; returns the runnable's path inside srcRoot. */
async function build(): Promise<string> {
  if (os === 'win32') {
    // MSVC: nmake -f Makefile.msvc builds bin\dcraw_emu.exe (+ bin\libraw.dll).
    // Must run inside a Visual Studio developer environment (the workflow uses
    // ilammy/msvc-dev-cmd so cl.exe / nmake are on PATH).
    await run('nmake', ['-f', 'Makefile.msvc', 'bin\\dcraw_emu.exe'], srcRoot);
    return path.join(srcRoot, 'bin', 'dcraw_emu.exe');
  }

  // macOS / Linux: LibRaw's dependency-free sample build.
  const env: NodeJS.ProcessEnv = {};
  if (os === 'darwin') {
    // One universal2 (arm64 + x86_64) binary; clang accepts multiple -arch.
    const archFlags = '-arch arm64 -arch x86_64';
    env.CFLAGS = `${archFlags} -mmacosx-version-min=11.0`;
    env.CXXFLAGS = env.CFLAGS;
    env.LDFLAGS = archFlags;
  } else {
    // Portable Linux: fold libstdc++/libgcc in so the binary runs without a
    // matching toolchain runtime. Build in an old-glibc container (manylinux)
    // in CI for maximum reach; that's the workflow's job, not this script's.
    env.LDFLAGS = '-static-libstdc++ -static-libgcc';
  }
  await run('make', ['-f', 'Makefile.dist', 'bin/dcraw_emu'], srcRoot, env);
  return path.join(srcRoot, 'bin', 'dcraw_emu');
}

/** Copy a legal/notice file from the source root into staged/ if it exists. */
async function stageLegal(staged: string, name: string): Promise<void> {
  const p = path.join(srcRoot, name);
  if (existsSync(p)) await copyFile(p, path.join(staged, name));
}

async function main(): Promise<void> {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  const tgz = path.join(workDir, 'src.tar.gz');
  console.error(`↓ ${SRC_URL}`);
  await download(SRC_URL, tgz);
  await run('tar', ['-xzf', tgz, '-C', workDir]);
  if (!existsSync(srcRoot)) throw new Error(`extracted source dir not found: ${srcRoot}`);

  console.error(`⚙ building dcraw_emu (${os}/${arch})`);
  const built = await build();
  if (!existsSync(built)) throw new Error(`build produced no binary at ${built}`);

  // Stage the runnable + license/notices + a source pointer (CDDL compliance).
  const staged = path.join(workDir, 'staged');
  await mkdir(staged, { recursive: true });
  await copyFile(built, path.join(staged, path.basename(built)));
  if (os === 'win32') {
    const dll = path.join(srcRoot, 'bin', 'libraw.dll');
    if (existsSync(dll)) await copyFile(dll, path.join(staged, 'libraw.dll'));
  }
  for (const legal of ['LICENSE.LGPL', 'LICENSE.CDDL', 'COPYRIGHT']) await stageLegal(staged, legal);
  await writeFile(
    path.join(staged, 'SOURCE.txt'),
    `LibRaw ${version}\nSource: ${SRC_URL}\nRedistributed under CDDL-1.0; the exact source tarball is published beside this archive on the release.\n`,
    'utf8',
  );

  const outPath = path.join(outDir, archiveName());
  await run('tar', ['-czf', outPath, '-C', staged, '.']);
  await rm(workDir, { recursive: true, force: true });

  const digest = await sha256(outPath);
  console.error(`\n✓ built ${outPath}`);
  console.log(`${os}-${arch}: sha256 = ${digest}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
