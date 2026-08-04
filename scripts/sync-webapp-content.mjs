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
// The webapp's sidebar (lib/docs/nav.ts) is hand-maintained but must cover every
// page — its build asserts that — so a page added or removed here is patched into
// it as well, in the order and with the wording of the README tables.
//
// Run by .github/workflows/sync-webapp.yml, which commits the result only when
// it differs. Locally: `node scripts/sync-webapp-content.mjs --out ../shoots-ai`.
import { cp, mkdir, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NAV_FILE = join("lib", "docs", "nav.ts");
/** Entries longer than this are written in the wrapped form nav.ts uses. */
const NAV_LINE_WIDTH = 120;

function outDir() {
  const index = process.argv.indexOf("--out");
  const value = index === -1 ? process.env.WEBAPP_DIR : process.argv[index + 1];
  if (!value) throw new Error("missing target: pass --out <dir> or set WEBAPP_DIR");
  return resolve(process.cwd(), value);
}

/** "docs/commands/cull.md" -> "commands/cull"; a README is its directory. */
function relToSlugKey(rel) {
  const withoutExt = rel.replace(/\\/g, "/").replace(/\.md$/, "");
  return withoutExt === "README" ? "" : withoutExt.replace(/\/README$/, "");
}

/** Every documented page, as slug keys ("" is the docs index). */
async function docsSlugKeys(docsDir) {
  const entries = await readdir(docsDir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => {
      const dir = entry.parentPath ?? entry.path;
      return relToSlugKey(join(dir, entry.name).slice(docsDir.length + 1));
    });
}

function stripMarkdown(text) {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text, max = 96) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[,;:.]$/, "")}…`;
}

/**
 * The README tables are the source of truth for a page's title, one-line
 * summary and position among its siblings. Reads `docs/README.md` and every
 * per-directory README under it, and returns the rows keyed by slug, in table
 * order.
 */
async function readNavHints(docsDir) {
  const hints = new Map();
  const readmes = (await docsSlugKeys(docsDir)).filter(
    (key) => key === "" || existsSync(join(docsDir, key, "README.md")),
  );

  for (const readmeKey of readmes) {
    const source = await readFile(join(docsDir, readmeKey, "README.md"), "utf8");
    const rows = source.matchAll(/^\|\s*\[(.+?)\]\(\.\/(.+?\.md)\)\s*\|(.*?)\|\s*$/gm);
    const siblings = [];
    for (const [, title, target, description] of rows) {
      const key = relToSlugKey(readmeKey ? `${readmeKey}/${target}` : target);
      if (hints.has(key)) continue;
      hints.set(key, {
        title: stripMarkdown(title),
        summary: truncate(stripMarkdown(description)) || undefined,
        siblings,
      });
      siblings.push(key);
    }
  }
  return hints;
}

/**
 * Spans of the `{ slug: [...], ... }` object literals in nav.ts, comma included.
 * Brace counting skips string literals — summaries contain `{date}` tokens.
 */
function navEntries(source) {
  const entries = [];
  for (const match of source.matchAll(/\{\s*slug:\s*\[([^\]]*)\]/g)) {
    const key = [...match[1].matchAll(/"([^"]*)"/g)].map(([, part]) => part).join("/");
    let depth = 0;
    let quote = "";
    let index = match.index;
    for (; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (char === "\\") index += 1;
        else if (char === quote) quote = "";
        continue;
      }
      if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "{") depth += 1;
      else if (char === "}" && (depth -= 1) === 0) break;
    }
    let end = index + 1;
    if (source[end] === ",") end += 1;
    const lineStart = source.lastIndexOf("\n", match.index) + 1;
    entries.push({ key, start: match.index, end, indent: source.slice(lineStart, match.index) });
  }
  return entries;
}

/** The object literal, indented but with no trailing comma. */
function renderNavEntry(key, hint, indent) {
  const slug = key === "" ? "[]" : `[${key.split("/").map((part) => JSON.stringify(part)).join(", ")}]`;
  const summary = hint.summary ? [`summary: ${JSON.stringify(hint.summary)}`] : [];
  const fields = [`slug: ${slug}`, `title: ${JSON.stringify(hint.title)}`, ...summary];

  const single = `${indent}{ ${fields.join(", ")} },`;
  if (single.length <= NAV_LINE_WIDTH) return `${indent}{ ${fields.join(", ")} }`;
  return [`${indent}{`, ...fields.map((field) => `${indent}  ${field},`), `${indent}}`].join("\n");
}

/** Bounds of a group's `items: [ … ]`, where an entry with no anchor goes. */
function groupItems(source, groupName) {
  const group = source.indexOf(`name: ${JSON.stringify(groupName)}`);
  if (group === -1) return undefined;
  const open = source.indexOf("items: [", group) + "items: ".length;
  if (open < "items: ".length) return undefined;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "[") depth += 1;
    else if (source[index] === "]" && (depth -= 1) === 0) return { open, close: index };
  }
  return undefined;
}

/** Appends an entry to a group's items, keeping the array's current shape. */
function appendToItems(source, bounds, rendered) {
  const { open, close } = bounds;
  const inner = source.slice(open + 1, close);
  const head = source.slice(0, close);
  const tail = source.slice(close);

  if (inner.trim() === "") {
    const closeIndent = rendered.slice(0, rendered.search(/\S/)).slice(2);
    return `${source.slice(0, open + 1)}\n${rendered},\n${closeIndent}${tail}`;
  }
  if (!inner.includes("\n")) return `${head.replace(/\s*$/, "")}, ${rendered.trim()}${tail}`;

  const closeIndent = head.slice(head.lastIndexOf("\n") + 1);
  const separator = /[,[]\s*$/.test(head) ? "" : ",";
  return `${head.trimEnd()}${separator}\n${rendered},\n${closeIndent}${tail}`;
}

/**
 * Adds sidebar entries for pages the nav does not list yet and drops entries
 * whose markdown file is gone — both fail the webapp build otherwise.
 */
async function syncNav(out, docsDir) {
  const navPath = join(out, NAV_FILE);
  if (!existsSync(navPath)) {
    console.warn(`[sync-webapp] no ${NAV_FILE} in the checkout — sidebar not updated`);
    return;
  }

  const keys = new Set(await docsSlugKeys(docsDir));
  const hints = await readNavHints(docsDir);
  let source = await readFile(navPath, "utf8");
  const added = [];
  const removed = [];

  for (const entry of navEntries(source).reverse()) {
    if (keys.has(entry.key)) continue;
    const lineStart = source.lastIndexOf("\n", entry.start);
    source = source.slice(0, lineStart) + source.slice(entry.end);
    removed.push(entry.key);
  }

  // One at a time: each insertion can be the anchor of the next missing sibling.
  for (let guard = 0; guard < keys.size; guard += 1) {
    const listed = navEntries(source);
    const listedKeys = new Set(listed.map((entry) => entry.key));
    const missing = [...keys].find((key) => !listedKeys.has(key));
    if (missing === undefined) break;

    const hint = hints.get(missing) ?? { title: missing === "" ? "Introduction" : missing.split("/").pop() };
    const siblings = hint.siblings ?? [];
    const position = siblings.indexOf(missing);
    const before = siblings.slice(0, Math.max(position, 0)).reverse().find((key) => listedKeys.has(key));
    const after = position === -1 ? undefined : siblings.slice(position + 1).find((key) => listedKeys.has(key));

    const anchor = listed.find((entry) => entry.key === (before ?? after));
    const indent = anchor?.indent ?? "      ";
    const rendered = renderNavEntry(missing, hint, indent);

    if (anchor && before) {
      const comma = source[anchor.end - 1] === "," ? "" : ",";
      source = `${source.slice(0, anchor.end)}${comma}\n${rendered},${source.slice(anchor.end)}`;
    } else if (anchor) {
      const lineStart = source.lastIndexOf("\n", anchor.start) + 1;
      source = `${source.slice(0, lineStart)}${rendered},\n${source.slice(lineStart)}`;
    } else {
      // No documented sibling to anchor to: park it at the end of a group.
      const group = missing === "" ? "Overview" : missing.startsWith("commands") ? "Commands" : "Reference";
      const bounds = groupItems(source, group);
      if (bounds === undefined) throw new Error(`cannot place "${missing}" in ${NAV_FILE}`);
      source = appendToItems(source, bounds, rendered);
      console.warn(`[sync-webapp] "${missing}" has no README row — appended, review its placement`);
    }
    added.push(missing);
  }

  if (added.length === 0 && removed.length === 0) return;
  await writeFile(navPath, source);
  const change = [
    added.length ? `+${added.join(", +")}` : "",
    removed.length ? `-${removed.join(", -")}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  console.log(`[sync-webapp] sidebar updated: ${change}`);
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

  await syncNav(out, join(repo, "docs"));

  console.log(`[sync-webapp] docs + assets synced into ${out} (shoots v${pkg.version})`);
}

main().catch((error) => {
  console.error(`[sync-webapp] ${error.message}`);
  process.exit(1);
});
