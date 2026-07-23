/**
 * Autocomplete engine for the interactive shell:
 * - `/prefix` at the start of the line → command suggestions
 * - a trailing `@partial/path` token → filesystem suggestions (dirs first)
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { COMMANDS } from './catalog.js';

export interface Suggestion {
  /** The full replacement input line if this suggestion is accepted. */
  apply: string;
  label: string;
  hint?: string;
  kind: 'command' | 'path';
}

export interface SuggestionResult {
  items: Suggestion[];
  /** How many further matches exist beyond `items` (shown as "+N more"). */
  hiddenCount: number;
}

const NONE: SuggestionResult = { items: [], hiddenCount: 0 };

/** Never flood the dropdown: cap the list and report how much was cut. */
const MAX_PATH_SUGGESTIONS = 6;

/** Matches a trailing unquoted `@partial` mention at the end of the input. */
const MENTION_RE = /(^|\s)@([^\s"']*)$/;

export async function getSuggestions(input: string, cwd: string): Promise<SuggestionResult> {
  // ---- command mode: "/par" (no space typed yet) ----
  if (input.startsWith('/') && !input.includes(' ')) {
    const prefix = input.slice(1).toLowerCase();
    const items = COMMANDS.filter((c) => c.name.startsWith(prefix)).map((c) => ({
      apply: `/${c.name} `,
      label: `/${c.name}`,
      hint: c.summary,
      kind: 'command' as const,
    }));
    return { items, hiddenCount: 0 };
  }

  // ---- mention mode: last token is "@partial" ----
  const match = MENTION_RE.exec(input);
  if (!match) return NONE;

  const partial = match[2].replace(/\\/g, '/');
  const lastSlash = partial.lastIndexOf('/');
  const dirPart = lastSlash >= 0 ? partial.slice(0, lastSlash + 1) : '';
  const basePart = (lastSlash >= 0 ? partial.slice(lastSlash + 1) : partial).toLowerCase();
  const dirAbs = path.resolve(cwd, dirPart === '' ? '.' : dirPart);

  let entries;
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return NONE;
  }

  const before = input.slice(0, match.index + match[1].length);
  const matches = entries
    .filter((e) => !e.name.startsWith('.') && e.name.toLowerCase().startsWith(basePart))
    .sort(
      (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
    );

  const items = matches.slice(0, MAX_PATH_SUGGESTIONS).map((e) => {
    const isDir = e.isDirectory();
    const completed = dirPart + e.name + (isDir ? '/' : '');
    const quoted = /\s/.test(completed) ? `"${completed}"` : completed;
    return {
      // Directories stay "open" for deeper completion; files get a trailing space.
      apply: `${before}@${quoted}${isDir ? '' : ' '}`,
      label: e.name + (isDir ? '/' : ''),
      hint: isDir ? 'dir' : 'file',
      kind: 'path' as const,
    };
  });
  return { items, hiddenCount: matches.length - items.length };
}
