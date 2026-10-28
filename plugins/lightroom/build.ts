/**
 * Packages the Lightroom Classic plug-in for distribution:
 *   dist-plugin/shoots.lrplugin/                 — the folder Lightroom loads
 *   dist-plugin/shoots-lightroom-<version>.zip   — the same folder, zipped
 *
 * The source folder is `shoots.lrdevplugin` (Lightroom's convention for a
 * development copy); the build renames it and stamps the release version from
 * the root package.json into Info.lua.
 *
 *   npm run build:lrplugin
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
export const SOURCE_DIR = path.join(here, 'shoots.lrdevplugin');
export const PLUGIN_FOLDER = 'shoots.lrplugin';

const VERSION_LINE = /VERSION = \{[^}]*\}/;

/** Replace Info.lua's VERSION table with `version` (x.y.z, optional -prerelease). */
export function stampInfoVersion(infoLua: string, version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
  if (!m) throw new Error(`not a release version: ${version}`);
  if (!VERSION_LINE.test(infoLua)) throw new Error('Info.lua has no VERSION table to stamp');
  const [, major, minor, revision] = m;
  return infoLua.replace(
    VERSION_LINE,
    `VERSION = { major = ${major}, minor = ${minor}, revision = ${revision}, display = '${version}' }`,
  );
}

/** Build into `outDir`; returns the folder and zip paths. */
export async function buildPlugin(outDir: string, version: string): Promise<{ folder: string; zip: string }> {
  const folder = path.join(outDir, PLUGIN_FOLDER);
  await rm(folder, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await cp(SOURCE_DIR, folder, { recursive: true });

  const infoPath = path.join(folder, 'Info.lua');
  await writeFile(infoPath, stampInfoVersion(await readFile(infoPath, 'utf8'), version), 'utf8');

  const zipPath = path.join(outDir, `shoots-lightroom-${version}.zip`);
  const zip = new AdmZip();
  zip.addLocalFolder(folder, PLUGIN_FOLDER);
  zip.writeZip(zipPath);
  return { folder, zip: zipPath };
}

if (import.meta.main) {
  const { version } = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8')) as { version: string };
  const { folder, zip } = await buildPlugin(path.join(repo, 'dist-plugin'), version);
  console.log(`Built ${folder}\n      ${zip}`);
}
