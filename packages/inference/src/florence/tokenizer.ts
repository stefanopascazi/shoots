/**
 * Florence-2's tokenizer: byte-level BPE (the BART/RoBERTa vocabulary) plus the
 * added task and location tokens, read from the model's own `tokenizer.json`.
 *
 * Written out rather than taken from a tokenizer library: it is a few dozen
 * lines, it runs inside the single binary with nothing to bundle, and the
 * format is stable — byte-level BPE has not changed since GPT-2.
 */

/** GPT-2's reversible byte ↔ printable-unicode map, so every byte has a visible token character. */
function bytesToUnicode(): Map<number, string> {
  const bs: number[] = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n++);
    }
  }
  return new Map(bs.map((b, i) => [b, String.fromCodePoint(cs[i]!)]));
}

const BYTE_TO_CHAR = bytesToUnicode();
const CHAR_TO_BYTE = new Map([...BYTE_TO_CHAR].map(([b, c]) => [c, b]));
/** GPT-2 pre-tokenisation: contractions, letter runs, digit runs, other runs, whitespace. */
const PRE_TOKENIZE = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

export interface TokenizerJson {
  model: { vocab: Record<string, number>; merges: (string | [string, string])[] };
  added_tokens: { id: number; content: string }[];
}

export interface Tokenizer {
  /** `<s>` + BPE ids + `</s>`, as the model's RoBERTa post-processor frames a prompt. */
  encode(text: string): number[];
  /** Ids back to text, added tokens (`<loc_123>`, `</s>`) kept verbatim. */
  decode(ids: readonly number[]): string;
  readonly bos: number;
  readonly eos: number;
}

export function createTokenizer(json: TokenizerJson): Tokenizer {
  const vocab = json.model.vocab;
  const ranks = new Map<string, number>();
  json.model.merges.forEach((m, i) => ranks.set(Array.isArray(m) ? m.join(' ') : m, i));
  const idToToken = new Map<number, string>();
  for (const [t, id] of Object.entries(vocab)) idToToken.set(id, t);
  const added = new Map<number, string>();
  for (const t of json.added_tokens) added.set(t.id, t.content);
  const id = (t: string): number => {
    const v = vocab[t] ?? json.added_tokens.find((a) => a.content === t)?.id;
    if (v === undefined) throw new Error(`token '${t}' is not in the vocabulary`);
    return v;
  };
  const bos = id('<s>');
  const eos = id('</s>');
  const cache = new Map<string, string[]>();

  /** Merge the lowest-ranked adjacent pair until no known pair remains. */
  function bpe(word: string): string[] {
    const hit = cache.get(word);
    if (hit) return hit;
    let parts = [...word];
    for (;;) {
      let best = -1;
      let bestRank = Infinity;
      for (let i = 0; i < parts.length - 1; i++) {
        const r = ranks.get(`${parts[i]} ${parts[i + 1]}`);
        if (r !== undefined && r < bestRank) [best, bestRank] = [i, r];
      }
      if (best < 0) break;
      parts = [...parts.slice(0, best), parts[best]! + parts[best + 1]!, ...parts.slice(best + 2)];
    }
    cache.set(word, parts);
    return parts;
  }

  return {
    bos,
    eos,
    encode(text) {
      const out = [bos];
      for (const piece of text.match(PRE_TOKENIZE) ?? []) {
        const chars = [...new TextEncoder().encode(piece)].map((b) => BYTE_TO_CHAR.get(b)!).join('');
        for (const t of bpe(chars)) out.push(id(t));
      }
      out.push(eos);
      return out;
    },
    decode(ids) {
      let text = '';
      let pending: number[] = [];
      const flush = (): void => {
        if (pending.length) text += new TextDecoder().decode(Uint8Array.from(pending));
        pending = [];
      };
      for (const i of ids) {
        const special = added.get(i);
        if (special !== undefined) {
          flush();
          text += special;
          continue;
        }
        for (const ch of idToToken.get(i) ?? '') {
          const b = CHAR_TO_BYTE.get(ch);
          if (b !== undefined) pending.push(b);
        }
      }
      flush();
      return text;
    },
  };
}
