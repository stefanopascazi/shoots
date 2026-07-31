/**
 * Sidebar structure and reading order for the documentation.
 *
 * Titles mirror `docs/README.md` and `docs/commands/README.md`; the order here
 * is also the prev/next order of the pager. `assertNavCoversContent` fails the
 * build if a markdown file lands in `docs/` without being listed.
 */

export interface DocsNavItem {
  /** Route slug segments under /docs — empty array is the docs index. */
  slug: string[];
  title: string;
  summary?: string;
}

export interface DocsNavGroup {
  name: string;
  icon: "compass" | "rocket" | "book" | "terminal" | "settings";
  items: DocsNavItem[];
}

export const docsNav: DocsNavGroup[] = [
  {
    name: "Overview",
    icon: "compass",
    items: [{ slug: [], title: "Introduction", summary: "What shoots is, and what it is not" }],
  },
  {
    name: "Start here",
    icon: "rocket",
    items: [
      { slug: ["getting-started"], title: "Getting started", summary: "Install, setup, doctor, your first import" },
      { slug: ["concepts"], title: "Core concepts", summary: "Non-destructive rules, exit codes, JSON output" },
      { slug: ["shell"], title: "Interactive shell", summary: "The fullscreen shell, / palette, @ mentions" },
    ],
  },
  {
    name: "Guides",
    icon: "book",
    items: [
      { slug: ["templates"], title: "Filename templates", summary: "The {date}_{camera}_{seq:4}.{ext} token language" },
      { slug: ["profiles"], title: "Rating profiles", summary: "Built-in profiles and how stars are decided" },
      { slug: ["preference-learning"], title: "Preference learning", summary: "embeddings → match duels → your own profile" },
      { slug: ["develop-predictor"], title: "Develop predictor", summary: "Learn your edit style, predict XMP" },
      { slug: ["pipelines"], title: "Pipelines", summary: "Declarative YAML pipelines" },
      { slug: ["scripting"], title: "Scripting & automation", summary: "JSON, exit codes, cron, CI, watch folders" },
      { slug: ["recipes"], title: "Recipes", summary: "Complete end-to-end workflows for real shoots" },
    ],
  },
  {
    name: "Commands",
    icon: "terminal",
    items: [
      { slug: ["commands"], title: "Command reference", summary: "Every command, every flag" },
      { slug: ["commands", "import"], title: "import", summary: "Card → catalog, renamed and checksum-verified" },
      { slug: ["commands", "rename"], title: "rename", summary: "Batch-rename an imported folder in place" },
      { slug: ["commands", "exif"], title: "exif", summary: "Batch read/write EXIF·IPTC·XMP metadata" },
      { slug: ["commands", "cull"], title: "cull", summary: "Focus-aware blur detection and review" },
      { slug: ["commands", "rate"], title: "rate", summary: "0–5 star ratings via the ONNX CLIP model" },
      { slug: ["commands", "embeddings"], title: "embeddings", summary: "Profile-neutral CLIP export" },
      { slug: ["commands", "match"], title: "match", summary: "Learn your eye from pairwise duels" },
      { slug: ["commands", "develop"], title: "develop", summary: "Personal develop-setting predictor" },
      { slug: ["commands", "schedule"], title: "schedule", summary: "Unattended daily refine via the OS scheduler" },
      { slug: ["commands", "setup"], title: "setup", summary: "Provision exiftool, LibRaw and the model" },
      { slug: ["commands", "doctor"], title: "doctor", summary: "Environment health check" },
      { slug: ["commands", "update"], title: "update", summary: "Self-update the standalone binary" },
    ],
  },
  {
    name: "Reference",
    icon: "settings",
    items: [
      { slug: ["configuration"], title: "Configuration", summary: "~/.shoots layout, every environment variable" },
      { slug: ["troubleshooting"], title: "Troubleshooting", summary: "Common failures and their fixes" },
      { slug: ["development"], title: "Development", summary: "Monorepo layout, build, release process" },
    ],
  },
];

/** Flat reading order, used by the pager and by generateStaticParams. */
export const docsNavItems: DocsNavItem[] = docsNav.flatMap((group) => group.items);

export function slugKey(slug: string[]): string {
  return slug.join("/");
}

export function docsHref(slug: string[]): string {
  return slug.length === 0 ? "/docs" : `/docs/${slug.join("/")}`;
}

export function findNavItem(slug: string[]): DocsNavItem | undefined {
  return docsNavItems.find((item) => slugKey(item.slug) === slugKey(slug));
}

export function findNeighbours(slug: string[]): {
  previous?: DocsNavItem;
  next?: DocsNavItem;
} {
  const index = docsNavItems.findIndex((item) => slugKey(item.slug) === slugKey(slug));
  if (index < 0) return {};
  return {
    previous: index > 0 ? docsNavItems[index - 1] : undefined,
    next: index < docsNavItems.length - 1 ? docsNavItems[index + 1] : undefined,
  };
}
