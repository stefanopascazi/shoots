import { readFile, readdir } from "node:fs/promises";
import { join, posix } from "node:path";

import { docsNavItems, slugKey } from "./nav";
import { repoPathToHref } from "./links";
import { renderMarkdown, type RenderedMarkdown } from "./markdown";

const CONTENT_ROOT = join(process.cwd(), "content");
const DOCS_ROOT = join(CONTENT_ROOT, "docs");

export interface DocPage extends RenderedMarkdown {
  slug: string[];
  href: string;
  /** Path of the source file in the repository, for the "edit on GitHub" link. */
  repoPath: string;
}

async function collectMarkdownFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) return collectMarkdownFiles(join(dir, entry.name), rel);
      return entry.name.endsWith(".md") ? [rel] : [];
    }),
  );
  return files.flat();
}

function relToSlug(rel: string): string[] {
  const withoutExt = rel.replace(/\.md$/, "");
  if (withoutExt === "README") return [];
  return withoutExt.replace(/\/README$/, "").split("/");
}

let indexPromise: Promise<Map<string, string>> | undefined;

/** slug key ("commands/cull") → path relative to content/docs. */
function getDocsIndex(): Promise<Map<string, string>> {
  indexPromise ??= collectMarkdownFiles(DOCS_ROOT).then(
    (files) => new Map(files.map((rel) => [slugKey(relToSlug(rel)), rel])),
  );
  return indexPromise;
}

export async function getDocSlugs(): Promise<string[][]> {
  const index = await getDocsIndex();
  return [...index.keys()].map((key) => (key === "" ? [] : key.split("/")));
}

export async function getDoc(slug: string[]): Promise<DocPage | undefined> {
  const index = await getDocsIndex();
  const rel = index.get(slugKey(slug));
  if (!rel) return undefined;

  const repoPath = posix.join("docs", rel);
  const source = await readFile(join(DOCS_ROOT, rel), "utf8");
  const rendered = await renderMarkdown(source, { repoPath });

  return { ...rendered, slug, href: repoPathToHref(repoPath), repoPath };
}

export async function getAllDocs(): Promise<DocPage[]> {
  const slugs = await getDocSlugs();
  const pages = await Promise.all(slugs.map((slug) => getDoc(slug)));
  return pages.filter((page): page is DocPage => Boolean(page));
}

/**
 * Guards against a docs page being added to the repo but never surfaced in the
 * sidebar. Called from the docs layout so a gap fails the build, not silently.
 */
export async function assertNavCoversContent(): Promise<void> {
  const index = await getDocsIndex();
  const listed = new Set(docsNavItems.map((item) => slugKey(item.slug)));
  const missing = [...index.keys()].filter((key) => !listed.has(key));
  if (missing.length > 0) {
    throw new Error(
      `docs pages missing from lib/docs/nav.ts: ${missing.map((m) => m || "(index)").join(", ")}`,
    );
  }
  const orphans = [...listed].filter((key) => !index.has(key));
  if (orphans.length > 0) {
    throw new Error(`nav entries with no markdown file: ${orphans.join(", ")}`);
  }
}
