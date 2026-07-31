// Vercel "Ignored Build Step" — wired up by webapp/vercel.json.
//
// Exit 1 = build, exit 0 = skip. (Yes, inverted from the usual convention: it
// mirrors `git diff --quiet`, which exits 1 when there ARE differences.)
//
// Vercel runs this from the Root Directory (webapp/) before installing anything,
// so it must stay dependency-free. Git commands run from the repo root because
// the diff paths are repository-relative.
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Everything the published site is built from. `package.json` is here because
 * the site reads the shoots version out of it — a release commit that touches
 * nothing else still has to redeploy, or the header keeps showing the old one.
 */
const WATCHED = ["webapp", "docs", "assets", "package.json"];

const BUILD = 1;
const SKIP = 0;

function git(args, { quiet = false } = {}) {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", quiet ? "ignore" : "inherit"],
  }).trim();
}

function log(message) {
  console.log(`[vercel-ignore] ${message}`);
}

function decide() {
  const head = process.env.VERCEL_GIT_COMMIT_SHA || "HEAD";
  const base = process.env.VERCEL_GIT_PREVIOUS_SHA;

  // A skipped build is not "keep the previous deployment": Vercel still creates a
  // deployment and still collects its output, which without `next build` is an
  // empty `.next`. Promote that to production and every page 404s. So the
  // optimisation is only ever safe on previews.
  if (process.env.VERCEL_ENV === "production") {
    log("production deployment — building");
    return BUILD;
  }

  // First deployment on this branch, or the variable is not exposed.
  if (!base) {
    log("no previous successful deployment — building");
    return BUILD;
  }

  // Redeploying the same commit: base === head, so the diff below is empty and
  // would skip the build the redeploy exists to run.
  if (base === head) {
    log("redeploy of the same commit — building");
    return BUILD;
  }

  // Vercel shallow-clones with --depth=10, so a base further back than that is
  // simply not in this checkout. Unknown history means build, never skip.
  try {
    git(["cat-file", "-e", `${base}^{commit}`], { quiet: true });
  } catch {
    log(`${base.slice(0, 8)} is outside the shallow clone — building to be safe`);
    return BUILD;
  }

  const changed = git(["diff", "--name-only", `${base}..${head}`, "--", ...WATCHED]);

  if (!changed) {
    log(`no changes under ${WATCHED.join(", ")} since ${base.slice(0, 8)} — skipping`);
    return SKIP;
  }

  log(`changed since ${base.slice(0, 8)}:`);
  for (const file of changed.split("\n")) log(`  ${file}`);
  return BUILD;
}

let code = BUILD;
try {
  code = decide();
} catch (error) {
  // A broken check must never silence a deployment.
  log(`check failed (${error.message}) — building`);
}

process.exit(code);
