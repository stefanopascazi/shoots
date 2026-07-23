/**
 * Quote-aware tokenizer for shell input lines, plus `@` mention expansion.
 * `/cull @"raw files/" --threshold 120` → ['cull', 'raw files/', '--threshold', '120']
 */

export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (ch === ' ' || ch === '\t') {
      if (started || current.length > 0) {
        tokens.push(current);
        current = '';
        started = false;
      }
    } else {
      current += ch;
    }
  }
  if (started || current.length > 0) tokens.push(current);
  return tokens;
}

/** Strip the leading `@` from mention tokens so they become plain paths. */
export function expandMentions(tokens: readonly string[]): string[] {
  return tokens.map((t) => (t.startsWith('@') && t.length > 1 ? t.slice(1) : t));
}
