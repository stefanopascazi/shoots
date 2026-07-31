import rehypeShiki from "@shikijs/rehype";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import GithubSlugger from "github-slugger";
import type { Heading, Link, Paragraph, Root, RootContent } from "mdast";
import type { Element, Root as HastRoot } from "hast";

import { resolveDocLink } from "./links";

export interface TocEntry {
  id: string;
  title: string;
  depth: 2 | 3;
}

export interface RenderedMarkdown {
  title: string;
  description?: string;
  html: string;
  toc: TocEntry[];
  /** Prose only (code blocks stripped) — feeds the search index. */
  text: string;
}

function toText(node: RootContent | Root): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node && Array.isArray(node.children)) {
    return node.children.map((child) => toText(child as RootContent)).join("");
  }
  return "";
}

/** Wraps tables so wide reference tables scroll instead of breaking the page. */
function rehypeScrollableTables() {
  return (tree: HastRoot) => {
    visit(tree, "element", (node: Element, index, parent) => {
      if (node.tagName !== "table" || !parent || index === undefined) return;
      const wrapper: Element = {
        type: "element",
        tagName: "div",
        properties: { className: ["md-table-scroll"] },
        children: [node],
      };
      (parent.children as unknown[])[index] = wrapper;
      return "skip" as const;
    });
  };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeSlug)
  .use(rehypeAutolinkHeadings, {
    behavior: "append",
    properties: { className: ["heading-anchor"], ariaHidden: "true", tabIndex: -1 },
    content: { type: "text", value: "#" },
  })
  .use(rehypeScrollableTables)
  .use(rehypeShiki, {
    theme: "github-dark",
    defaultLanguage: "text",
    fallbackLanguage: "text",
  })
  .use(rehypeStringify, { allowDangerousHtml: false });

/**
 * Renders one docs markdown file. The leading `# H1` and its intro paragraph are
 * lifted out of the body: the page shell renders them as title + description.
 */
export async function renderMarkdown(
  source: string,
  options: { repoPath: string },
): Promise<RenderedMarkdown> {
  const tree = processor.parse(source) as Root;

  let title = "";
  let description: string | undefined;

  const firstHeading = tree.children.findIndex(
    (node): node is Heading => node.type === "heading" && node.depth === 1,
  );
  if (firstHeading >= 0) {
    title = toText(tree.children[firstHeading]);
    const following = tree.children[firstHeading + 1] as Paragraph | undefined;
    const hasIntro = following?.type === "paragraph";
    if (hasIntro) description = toText(following).replace(/\s+/g, " ").trim();
    tree.children.splice(firstHeading, hasIntro ? 2 : 1);
  }

  const slugger = new GithubSlugger();
  const toc: TocEntry[] = [];
  const textParts: string[] = [];

  visit(tree, (node) => {
    if (node.type === "heading") {
      const heading = node as Heading;
      const value = toText(heading);
      const id = slugger.slug(value);
      if (heading.depth === 2 || heading.depth === 3) {
        toc.push({ id, title: value, depth: heading.depth });
      }
      textParts.push(value);
    } else if (node.type === "paragraph" || node.type === "tableCell") {
      textParts.push(toText(node as RootContent));
    }
  });

  visit(tree, "link", (node: Link) => {
    const resolved = resolveDocLink(options.repoPath, node.url);
    node.url = resolved.href;
    if (resolved.external) {
      node.data = {
        ...node.data,
        hProperties: { target: "_blank", rel: ["noreferrer"] },
      };
    }
  });

  const hast = (await processor.run(tree)) as unknown as HastRoot;
  const html = processor.stringify(hast);

  return {
    title,
    description,
    html,
    toc,
    text: textParts.join(" ").replace(/\s+/g, " ").trim(),
  };
}
