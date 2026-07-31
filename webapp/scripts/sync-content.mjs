// Mirrors the repo's canonical content into the webapp so the site can never
// drift from the source of truth.
//
// The result is COMMITTED, not gitignored: with a Vercel Root Directory of
// `webapp`, "files outside the root directory" is a dashboard toggle, and the
// Root Directory docs state the app cannot traverse up with `..`. The site must
// build from `webapp/` alone, so the snapshot ships with it.
//
// Runs on predev / prebuild / pretypecheck. With `--check` it fails instead when
// the snapshot is stale — that is the CI guard against a docs edit landing
// without a re-sync.
import { execFileSync } from "node:child_process";
import { cp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webapp = resolve(here, "..");
const repo = resolve(webapp, "..");

const contentDir = join(webapp, "content");
const publicAssets = join(webapp, "public", "assets");
const tracked = ["content", "public/assets"];

const checkOnly = process.argv.includes("--check");

async function sync() {
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

  // Deliberately free of timestamps: the snapshot must be byte-identical across
  // runs, or every build would dirty the working tree and trip the drift check.
  const pkg = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
  await writeFile(
    join(contentDir, "meta.json"),
    `${JSON.stringify({ version: pkg.version }, null, 2)}\n`,
  );

  return pkg.version;
}

function assertNoDrift() {
  const status = execFileSync("git", ["status", "--porcelain", "--", ...tracked], {
    cwd: webapp,
    encoding: "utf8",
  }).trim();

  if (status) {
    console.error(
      "[sync-content] the committed snapshot is stale. Run `npm run sync-content` and commit:\n" +
        status,
    );
    process.exit(1);
  }
  console.log("[sync-content] snapshot is up to date with ../docs");
}

async function main() {
  // Outside the monorepo (a Vercel build scoped to webapp/) there is nothing to
  // mirror — the committed snapshot is already the content.
  if (!existsSync(join(repo, "docs")) || !existsSync(join(repo, "package.json"))) {
    if (checkOnly) {
      console.error("[sync-content] --check needs the monorepo root; ../docs was not found");
      process.exit(1);
    }
    console.log("[sync-content] ../docs not available — building from the committed snapshot");
    return;
  }

  const version = await sync();

  if (checkOnly) assertNoDrift();
  else console.log(`[sync-content] docs + README + assets synced (shoots v${version})`);
}

main().catch((error) => {
  console.error("[sync-content] failed:", error);
  process.exit(1);
});
