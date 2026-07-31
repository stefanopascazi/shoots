// Mirrors the repo's canonical content into the webapp so the site can never
// drift from the source of truth. The output is gitignored and regenerated on
// predev / prebuild / pretypecheck — `docs/` is the only place it is authored.
//
// This means the build needs the monorepo root. On Vercel, a project with a Root
// Directory of `webapp` gets it through "Include source files outside of the Root
// Directory in the Build Step" (enabled by default since 2020-08-27); see the
// README.
import { cp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webapp = resolve(here, "..");
const repo = resolve(webapp, "..");

const contentDir = join(webapp, "content");
const publicAssets = join(webapp, "public", "assets");

async function main() {
  if (!existsSync(join(repo, "docs"))) {
    throw new Error(
      `${join(repo, "docs")} not found.\n` +
        "The site renders the repository documentation, so the build needs the monorepo root.\n" +
        'On Vercel, enable "Include source files outside of the Root Directory in the Build Step".',
    );
  }

  await rm(contentDir, { recursive: true, force: true });
  await mkdir(contentDir, { recursive: true });

  await cp(join(repo, "docs"), join(contentDir, "docs"), { recursive: true });
  await cp(join(repo, "README.md"), join(contentDir, "README.md"));

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

  console.log(`[sync-content] docs + README + assets synced (shoots v${pkg.version})`);
}

main().catch((error) => {
  console.error(`[sync-content] ${error.message}`);
  process.exit(1);
});
