// Mirrors the repo's canonical content into the webapp so the site can never
// drift from the source of truth. Run by `predev`/`prebuild`; output is gitignored.
import { cp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webapp = resolve(here, "..");
const repo = resolve(webapp, "..");

const contentDir = join(webapp, "content");
const publicAssets = join(webapp, "public", "assets");

async function main() {
  await rm(contentDir, { recursive: true, force: true });
  await mkdir(contentDir, { recursive: true });

  await cp(join(repo, "docs"), join(contentDir, "docs"), { recursive: true });
  await cp(join(repo, "README.md"), join(contentDir, "README.md"));

  await rm(publicAssets, { recursive: true, force: true });
  await mkdir(publicAssets, { recursive: true });
  await cp(join(repo, "assets"), publicAssets, {
    recursive: true,
    // Terminal captures ship as both PNG and SVG; the site only uses the PNGs.
    filter: (src) => !src.endsWith(".svg") || !src.includes("screens"),
  });

  const pkg = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
  await writeFile(
    join(contentDir, "meta.json"),
    `${JSON.stringify({ version: pkg.version, syncedAt: new Date().toISOString() }, null, 2)}\n`,
  );

  console.log(`[sync-content] docs + README + assets synced (shoots v${pkg.version})`);
}

main().catch((error) => {
  console.error("[sync-content] failed:", error);
  process.exit(1);
});
