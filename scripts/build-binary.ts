/**
 * Builds the shoots CLI into a standalone executable via Bun's compiler.
 *
 * Usage:
 *   bun scripts/build-binary.ts [--outfile <path>]
 *
 * The executable embeds the Bun runtime, the bundled JS and sharp's native
 * libraries for the *host* platform — cross-compilation is not supported
 * because sharp ships per-platform prebuilds. CI builds natively on each OS.
 *
 * How sharp is handled: its native addon (.node) depends on libvips shared
 * libraries that must sit at a fixed path relative to the addon (Windows DLL
 * search / ELF $ORIGIN rpath / Mach-O @loader_path). Bun's automatic .node
 * embedding extracts the addon alone, so the libraries are never found.
 * Instead we embed every native file as a plain asset, extract them at first
 * run into a per-version cache directory that mirrors the @img package
 * layout, and load the addon from there.
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
const imgRoot = path.join(repoRoot, 'node_modules', '@img');
// sharp's platform id: win32-x64, linux-x64, darwin-arm64... (musl not handled:
// CI builds on glibc runners).
const sharpPlatform = `${process.platform}-${process.arch}`;
const sharpVersion = (
  JSON.parse(readFileSync(path.join(repoRoot, 'node_modules', 'sharp', 'package.json'), 'utf8')) as {
    version: string;
  }
).version;
// User-facing shoots metadata — single source of truth: the root package.json.
const shootsPkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  version: string;
  author?: string;
};
const shootsVersion = shootsPkg.version;
const shootsAuthor = shootsPkg.author ?? '';

/**
 * Recursively collect regular files under a directory as paths relative to it.
 * The libvips prebuilds for linux/darwin nest subdirectories (e.g. `glib-2.0`)
 * inside `lib/`; blindly copyFileSync-ing every readdir entry throws ENOTSUP on
 * those directories, so we walk the tree and keep only regular files.
 */
function walkFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    // Resolve symlinks (many .so files are versioned symlinks) to decide
    // whether the target is a directory to recurse into or a file to copy.
    const stats = entry.isSymbolicLink() ? statSync(abs) : entry;
    if (stats.isDirectory()) {
      out.push(...walkFiles(abs, base));
    } else if (stats.isFile()) {
      out.push(path.relative(base, abs));
    }
  }
  return out;
}

/**
 * Stage native files with a `.bin` extension so Bun's bundler treats them as
 * plain embeddable assets: a `.node` extension would trigger dlopen semantics
 * on require, and we need paths, not loaded modules.
 */
function stageNativeFiles(): { staged: string; rel: string }[] {
  const staging = path.join(repoRoot, 'dist-bin', '.native-staging');
  mkdirSync(staging, { recursive: true });
  const entries: { staged: string; rel: string }[] = [];
  // On win32 the libvips DLLs live inside sharp-<platform> itself; on
  // linux/darwin they come from the separate sharp-libvips-<platform> package.
  for (const pkg of [`sharp-${sharpPlatform}`, `sharp-libvips-${sharpPlatform}`]) {
    const libDir = path.join(imgRoot, pkg, 'lib');
    if (!existsSync(libDir)) continue;
    for (const relFile of walkFiles(libDir)) {
      // rel is the path the loader recreates at runtime; keep POSIX separators.
      const rel = `${pkg}/lib/${relFile.split(path.sep).join('/')}`;
      // Flatten the (possibly nested) rel path into a single staged filename.
      const staged = path.join(staging, `${pkg}--${relFile.split(path.sep).join('__')}.bin`);
      copyFileSync(path.join(libDir, relFile), staged);
      entries.push({ staged, rel });
    }
  }
  if (entries.length === 0) {
    throw new Error(`no sharp prebuilt binaries found for ${sharpPlatform} under ${imgRoot}`);
  }
  return entries;
}

/**
 * Generates the module that replaces sharp/lib/sharp.js in the bundle.
 * At runtime it extracts the embedded native files into a cache directory
 * (skipping files already extracted with the right size) and requires the
 * addon from there.
 */
function generateSharpLoader(): string {
  const entries = stageNativeFiles();
  const nodeRel = `sharp-${sharpPlatform}/lib/sharp-${sharpPlatform}.node`;
  const cacheKey = `shoots-sharp-${sharpVersion}-${sharpPlatform}`;
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

module.exports = require(path.join(root, ${JSON.stringify(nodeRel)}));
`;
}

const staticSharpLoader = {
  name: 'static-sharp-loader',
  setup(build: import('bun').PluginBuilder) {
    const contents = generateSharpLoader();
    build.onLoad({ filter: /[\\/]sharp[\\/]lib[\\/]sharp\.js$/ }, () => ({
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

const result = await Bun.build({
  entrypoints: [path.join(repoRoot, 'packages', 'cli', 'src', 'cli.tsx')],
  define: {
    // Dead-code-eliminates React development branches.
    'process.env.NODE_ENV': '"production"',
    // Stamp the user-facing version and author into the binary.
    'process.env.SHOOTS_VERSION': JSON.stringify(shootsVersion),
    'process.env.SHOOTS_AUTHOR': JSON.stringify(shootsAuthor),
  },
  plugins: [staticSharpLoader, stubReactDevtools],
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
