import { getAllDocs } from "@/lib/docs/content";
import { docsNav, slugKey } from "@/lib/docs/nav";
import type { SearchEntry } from "@/lib/search";

export const dynamic = "force-static";

/**
 * Static search corpus, fetched by the Cmd+K dialog on first open so none of the
 * documentation text is shipped in the initial JS bundle.
 */
export async function GET() {
  const groupOf = new Map(
    docsNav.flatMap((group) => group.items.map((item) => [slugKey(item.slug), group.name])),
  );

  const docs = await getAllDocs();
  const entries: SearchEntry[] = docs.map((doc) => ({
    href: doc.href,
    title: doc.title,
    group: groupOf.get(slugKey(doc.slug)) ?? "Documentation",
    description: doc.description,
    headings: doc.toc.map(({ id, title }) => ({ id, title })),
    text: doc.text,
  }));

  return Response.json(entries);
}
