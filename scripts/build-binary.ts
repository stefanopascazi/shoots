/**
 * Builds the shoots CLI into a standalone executable via Bun's compiler.
 *
 * Usage:
 *   bun scripts/build-binary.ts [--outfile <path>]
 *
 * The executable embeds the Bun runtime, the bundled JS and the native
 * libraries of every native addon we depend on — for the *host* platform.
 * Cross-compilation is not supported because these addons ship per-platform
 * prebuilds; CI builds natively on each OS.
 *
 * Why native addons need special handling: an addon's `.node` file depends on
 * shared libraries (libvips for sharp, onnxruntime.dll/.so/.dylib for
 * onnxruntime-node) that the OS loader resolves *relative to the addon's own
 * directory*. Bun's automatic `.node` embedding extracts the addon alone, so
 * those sibling libraries are never found at runtime. Instead we embed every
 * native file as a plain asset, extract them at first run into a per-version
 * cache directory (addon + its libraries side by side), and load the addon
 * from there.
 *
 * NOTE: only the ONNX *runtime* is embedded here — the model *weights* are not.
 * Weights are downloaded on demand into ~/.shoots/models (see @shoots/inference
 * provisioning), mirroring how exiftool is provisioned.
 */
import { existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);

function argValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const outfile = argValue('--outfile') ?? 'dist-bin/shoots';

const repoRoot = path.resolve(import.meta.dir, '..');
const nodeModules = path.join(repoRoot, 'node_modules');
const imgRoot = path.join(nodeModules, '@img');
// Native addon platform id: win32-x64, linux-x64, darwin-arm64...
// (musl not handled: CI builds on glibc runners).
const hostPlatform = process.platform;
const hostArch = process.arch;
const sharpPlatform = `${hostPlatform}-${hostArch}`;

function pkgVersion(pkgDir: string): string {
  return (JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { version: string }).version;
}

const sharpVersion = pkgVersion(path.join(nodeModules, 'sharp'));
// User-facing shoots metadata — single source of truth: the root package.json.
const shootsPkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  version: string;
  author?: string;
};
const shootsVersion = shootsPkg.version;
const shootsAuthor = shootsPkg.author ?? '';

// ---------------------------------------------------------------------------
// Generic native-addon embedding
// ---------------------------------------------------------------------------

interface NativeFile {
  /** Absolute source path of the native file. */
  abs: string;
  /** Path the runtime loader recreates under the cache root (POSIX separators). */
  rel: string;
}

/**
 * Recursively collect regular files under a directory as {abs, rel} pairs.
 * Some libvips prebuilds nest subdirectories (e.g. `glib-2.0`) inside `lib/`;
 * readdir-ing blindly throws ENOTSUP on those, so we walk the tree and keep
 * only regular files. Symlinks (many versioned `.so`s) are resolved.
 */
function walkFiles(dir: string, base = dir): NativeFile[] {
  const out: NativeFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const stats = entry.isSymbolicLink() ? statSync(abs) : entry;
    if (stats.isDirectory()) {
      out.push(...walkFiles(abs, base));
    } else if (stats.isFile()) {
      out.push({ abs, rel: path.relative(base, abs).split(path.sep).join('/') });
    }
  }
  return out;
}

/**
 * Copy native files into `dist-bin/.native-staging` under a flat, prefixed
 * name (with a `.bin` extension so Bun's bundler treats them as plain
 * embeddable assets — a `.node` extension would trigger dlopen-on-require).
 * Returns the staged path alongside the runtime-relative path to recreate.
 */
function stageFiles(files: NativeFile[], prefix: string): { staged: string; rel: string }[] {
  const staging = path.join(repoRoot, 'dist-bin', '.native-staging');
  mkdirSync(staging, { recursive: true });
  return files.map(({ abs, rel }) => {
    const staged = path.join(staging, `${prefix}--${rel.split('/').join('__')}.bin`);
    copyFileSync(abs, staged);
    return { staged, rel };
  });
}

/**
 * Generate the JS module body that, at first run, extracts embedded native
 * files into a per-version cache directory and `require`s the addon from there.
 * `requireRel` is the addon path (relative to the cache root) to load and
 * re-export.
 */
function generateExtractorModule(
  entries: { staged: string; rel: string }[],
  cacheKey: string,
  requireRel: string,
): string {
  const imports = entries
    .map((e) => `[require(${JSON.stringify(e.staged)}), ${JSON.stringify(e.rel)}]`)
    .join(',\n  ');
  return `
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const entries = [
  ${imports}
];

const root = path.join(os.tmpdir(), ${JSON.stringify(cacheKey)});
for (const [src, rel] of entries) {
  const dest = path.join(root, rel);
  const data = fs.readFileSync(src);
  let upToDate = false;
  try {
    upToDate = fs.statSync(dest).size === data.length;
  } catch {}
  if (!upToDate) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // Write-then-rename so concurrent first runs never load a half-written
    // library. If the rename loses a race the destination is already valid.
    const tmp = dest + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, data);
    try {
      fs.renameSync(tmp, dest);
    } catch {
      fs.rmSync(tmp, { force: true });
    }
  }
}

module.exports = require(path.join(root, ${JSON.stringify(requireRel)}));
`;
}

// ---------------------------------------------------------------------------
// sharp: replace sharp/lib/sharp.js with an extractor that loads the addon.
// ---------------------------------------------------------------------------

function sharpLoaderContents(): string {
  const files: NativeFile[] = [];
  // On win32 the libvips DLLs live inside sharp-<platform> itself; on
  // linux/darwin they come from the separate sharp-libvips-<platform> package.
  for (const pkg of [`sharp-${sharpPlatform}`, `sharp-libvips-${sharpPlatform}`]) {
    const libDir = path.join(imgRoot, pkg, 'lib');
    if (!existsSync(libDir)) continue;
    for (const f of walkFiles(libDir)) {
      files.push({ abs: f.abs, rel: `${pkg}/lib/${f.rel}` });
    }
  }
  if (files.length === 0) {
    throw new Error(`no sharp prebuilt binaries found for ${sharpPlatform} under ${imgRoot}`);
  }
  const entries = stageFiles(files, 'sharp');
  // sharp >=0.35 suffixes the addon with its version (sharp-win32-x64-0.35.3.node),
  // earlier releases did not — resolve it from the staged files instead of guessing.
  const addon = files.find(
    (f) => f.rel.startsWith(`sharp-${sharpPlatform}/lib/`) && f.rel.endsWith('.node'),
  );
  if (!addon) {
    throw new Error(`no sharp addon (.node) found for ${sharpPlatform} under ${imgRoot}`);
  }
  return generateExtractorModule(
    entries,
    `shoots-sharp-${sharpVersion}-${sharpPlatform}`,
    addon.rel,
  );
}

const staticSharpLoader = {
  name: 'static-sharp-loader',
  setup(build: import('bun').PluginBuilder) {
    const contents = sharpLoaderContents();
    // sharp <0.35 loaded the addon from lib/sharp.js (CJS); >=0.35 ships dual
    // builds and the ESM entry pulls dist/sharp.mjs. Match either.
    build.onLoad({ filter: /[\\/]sharp[\\/](lib[\\/]sharp\.js|dist[\\/]sharp\.mjs)$/ }, () => ({
      contents,
      loader: 'js' as const,
    }));
  },
};

// ---------------------------------------------------------------------------
// onnxruntime-node: intercept the `require(...onnxruntime_binding.node)` in
// dist/binding.js and route it to an extractor that co-locates the addon with
// onnxruntime.dll/.so/.dylib in a cache dir, then loads it from there.
// ---------------------------------------------------------------------------

// The win32 prebuild bundles the DirectML execution provider (DirectML.dll,
// dxcompiler.dll, dxil.dll — ~38MB). shoots rates on CPU, so these are dropped
// to keep the binary small; only the addon and the core runtime are embedded.
const ORT_SKIP = /^(DirectML|dxcompiler|dxil)\.dll$/i;

function ortLoaderContents(): string | null {
  const ortRoot = path.join(nodeModules, 'onnxruntime-node');
  if (!existsSync(ortRoot)) return null; // dependency not installed — skip
  const ortVersion = pkgVersion(ortRoot);
  const platformDir = path.join(ortRoot, 'bin', 'napi-v6', hostPlatform, hostArch);
  if (!existsSync(platformDir)) {
    throw new Error(`no onnxruntime-node prebuilt binaries found at ${platformDir}`);
  }
  // Flat directory: addon + its sibling shared libraries, all in one place so
  // the OS loader resolves the dependent library next to the addon.
  const files = walkFiles(platformDir).filter((f) => !ORT_SKIP.test(path.basename(f.rel)));
  const entries = stageFiles(files, 'ort');
  return generateExtractorModule(
    entries,
    `shoots-ort-${ortVersion}-${sharpPlatform}`,
    'onnxruntime_binding.node',
  );
}

const staticOrtLoader = {
  name: 'static-onnxruntime-loader',
  setup(build: import('bun').PluginBuilder) {
    const contents = ortLoaderContents();
    if (contents === null) return; // onnxruntime-node absent: nothing to embed
    // Match the addon require target regardless of the platform/arch segment.
    build.onResolve({ filter: /onnxruntime_binding\.node$/ }, () => ({
      path: 'onnxruntime_binding.node',
      namespace: 'ort-addon',
    }));
    build.onLoad({ filter: /.*/, namespace: 'ort-addon' }, () => ({
      contents,
      loader: 'js' as const,
    }));
  },
};

/**
 * ink unconditionally references `react-devtools-core` (an optional peer
 * dependency, only loaded when DEV=true) from its devtools module. The
 * standalone compiler resolves the whole module graph eagerly, so we stub
 * the package out with an empty module instead of shipping devtools.
 */
const stubReactDevtools = {
  name: 'stub-react-devtools-core',
  setup(build: import('bun').PluginBuilder) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'react-devtools-core',
      namespace: 'stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export default {};',
      loader: 'js' as const,
    }));
  },
};

const entrypoint = argValue('--entry') ?? path.join(repoRoot, 'packages', 'cli', 'src', 'cli.tsx');

const result = await Bun.build({
  entrypoints: [entrypoint],
  define: {
    // Dead-code-eliminates React development branches.
    'process.env.NODE_ENV': '"production"',
    // Stamp the user-facing version and author into the binary.
    'process.env.SHOOTS_VERSION': JSON.stringify(shootsVersion),
    'process.env.SHOOTS_AUTHOR': JSON.stringify(shootsAuthor),
  },
  plugins: [staticSharpLoader, staticOrtLoader, stubReactDevtools],
  compile: {
    outfile,
  },
  sourcemap: 'none',
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

for (const artifact of result.outputs) {
  console.log(`built ${artifact.path}`);
}
