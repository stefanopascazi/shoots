import { dirname, join, normalize } from "node:path/posix";

import { site } from "@/lib/site";

const DOCS_ROOT = "docs/";

export interface ResolvedLink {
  href: string;
  external: boolean;
}

/** Maps a repo-relative markdown path to its route under /docs. */
export function repoPathToHref(repoPath: string): string {
  const rel = repoPath.slice(DOCS_ROOT.length).replace(/\.md$/, "");
  if (rel === "README") return "/docs";
  if (rel.endsWith("/README")) return `/docs/${rel.slice(0, -"/README".length)}`;
  return `/docs/${rel}`;
}

/**
 * Rewrites a link found inside a docs page.
 *
 * Relative `.md` links become site routes; anything else that points into the
 * repository (LICENSE, assets, source files) becomes a GitHub blob URL, so the
 * markdown stays valid both on GitHub and here.
 */
export function resolveDocLink(fromRepoPath: string, href: string): ResolvedLink {
  if (!href) return { href, external: false };
  if (href.startsWith("#")) return { href, external: false };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) {
    return { href, external: true };
  }

  const hashIndex = href.indexOf("#");
  const pathPart = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  const hash = hashIndex >= 0 ? href.slice(hashIndex) : "";

  const target = normalize(join(dirname(fromRepoPath), pathPart));

  if (target.startsWith(DOCS_ROOT) && target.endsWith(".md")) {
    return { href: `${repoPathToHref(target)}${hash}`, external: false };
  }

  return { href: `${site.repoBlob}/${target}${hash}`, external: true };
}
