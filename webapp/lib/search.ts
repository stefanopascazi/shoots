export interface SearchEntry {
  href: string;
  title: string;
  group: string;
  description?: string;
  headings: { id: string; title: string }[];
  text: string;
}

export interface SearchResult {
  href: string;
  title: string;
  group: string;
  /** Matching heading, when the query hit a section rather than the page itself. */
  section?: string;
  snippet: string;
}

const SNIPPET_RADIUS = 90;

function buildSnippet(text: string, needle: string): string {
  const at = text.toLowerCase().indexOf(needle);
  if (at < 0) return text.slice(0, SNIPPET_RADIUS * 2).trim();
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + needle.length + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/**
 * Small ranked substring search over the docs corpus. Deliberately dependency
 * free: the corpus is a few hundred KB and scoring runs on every keystroke.
 */
export function searchDocs(entries: SearchEntry[], query: string, limit = 10): SearchResult[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length < 2) return [];
  const tokens = trimmed.split(/\s+/);

  const scored = entries.flatMap((entry) => {
    const title = entry.title.toLowerCase();
    const description = entry.description?.toLowerCase() ?? "";
    const text = entry.text.toLowerCase();

    let score = 0;
    if (title.includes(trimmed)) score += 120;
    if (description.includes(trimmed)) score += 40;
    if (text.includes(trimmed)) score += 20;

    for (const token of tokens) {
      if (title.includes(token)) score += 30;
      if (description.includes(token)) score += 10;
      if (text.includes(token)) score += 4;
    }

    const heading = entry.headings.find((item) => item.title.toLowerCase().includes(trimmed));
    if (heading) score += 60;

    if (score === 0) return [];

    return [
      {
        score,
        result: {
          href: heading ? `${entry.href}#${heading.id}` : entry.href,
          title: entry.title,
          group: entry.group,
          section: heading?.title,
          snippet: entry.description ?? buildSnippet(entry.text, trimmed),
        } satisfies SearchResult,
      },
    ];
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.result);
}
