// Mirrors this repo's canonical content into a checkout of the webapp repo
// (github.com/stefanopascazi/shoots-ai), which lives outside the monorepo but
// publishes its documentation.
//
// `docs/`, `assets/` and the version in `package.json` are authored here and
// nowhere else; the webapp only ever consumes the copy this script writes:
//   docs/       -> <out>/content/docs
//   assets/     -> <out>/public/assets
//   version     -> <out>/content/meta.json
//
// Run by .github/workflows/sync-webapp.yml, which commits the result only when
// it differs. Locally: `node scripts/sync-webapp-content.mjs --out ../shoots-ai`.
import { cp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function outDir() {
  const index = process.argv.indexOf("--out");
  const value = index === -1 ? process.env.WEBAPP_DIR : process.argv[index + 1];
  if (!value) throw new Error("missing target: pass --out <dir> or set WEBAPP_DIR");
  return resolve(process.cwd(), value);
}

async function main() {
  const out = outDir();

  // A wrong --out would happily create content/ inside an unrelated directory,
  // so require a marker that only the webapp checkout has.
  if (!existsSync(join(out, "next.config.ts"))) {
    throw new Error(`${out} does not look like the webapp checkout (no next.config.ts)`);
  }

  const contentDir = join(out, "content");
  const publicAssets = join(out, "public", "assets");

  await rm(contentDir, { recursive: true, force: true });
  await mkdir(contentDir, { recursive: true });
  await cp(join(repo, "docs"), join(contentDir, "docs"), { recursive: true });

  await rm(publicAssets, { recursive: true, force: true });
  await mkdir(publicAssets, { recursive: true });
  await cp(join(repo, "assets"), publicAssets, {
    recursive: true,
    filter: (src) =>
      // Terminal captures ship as both PNG and SVG; the site only uses the PNGs,
      // and the capture index is documentation, not a public asset.
      !src.endsWith(".md") && (!src.endsWith(".svg") || !src.includes("screens")),
  });

  const pkg = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
  await writeFile(
    join(contentDir, "meta.json"),
    `${JSON.stringify({ version: pkg.version }, null, 2)}\n`,
  );

  console.log(`[sync-webapp] docs + assets synced into ${out} (shoots v${pkg.version})`);
}

main().catch((error) => {
  console.error(`[sync-webapp] ${error.message}`);
  process.exit(1);
});
