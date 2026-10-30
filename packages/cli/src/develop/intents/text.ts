/**
 * Develop intents from what the photographer writes, in Italian or English.
 *
 * "Salva il cielo e apri un po' le ombre, contrasto basso" → save-the-sky,
 * open-shadows, soft-contrast. There are only eight intents, so this is a small
 * lexicon of word stems rather than a language model: deterministic, testable,
 * nothing to download, and every decision can be shown back to the
 * photographer — which is the point, since the result is meant to be confirmed
 * before it is applied. What it does not understand it says so, clause by
 * clause, instead of guessing.
 */

export interface ParsedIntents {
  /** Intent ids understood, in the order first mentioned. */
  intents: string[];
  /** Which clause produced which intent, for showing the interpretation back. */
  matched: { clause: string; intent: string }[];
  /** Clauses that named nothing this knows, or only asked *not* to do something. */
  unmatched: string[];
}

/** Lowercase, accents off, apostrophes to spaces: "Più" and "piu", "l'esposizione" and "l esposizione" alike. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’'`]/g, ' ')
    .replace(/\s+/g, ' ');
}

/** Clauses: punctuation, line breaks, and the conjunctions that join separate requests. */
function clauses(text: string): string[] {
  return normalize(text)
    .split(/[.,;:!?\n]+|\s(?:e|ed|and|ma|but|poi|then|also|anche)\s/)
    .map((c) => c.trim())
    .filter(Boolean);
}

const NEGATION = /\b(non|no|not|don t|dont|do not|never|mai|senza|without|avoid|evita|evitare|niente)\b/;

interface Rule {
  intent: string;
  /** Every pattern must match the clause. */
  all: RegExp[];
}

// Region rules come first: "recupera le luci del cielo" is about the sky, not
// every highlight in the frame.
const RULES: Rule[] = [
  { intent: 'save-the-sky', all: [/\b(ciel|sky|skies|nuvol|cloud)/] },
  {
    intent: 'lift-the-subject',
    all: [/\b(soggett|vis[oi]\b|volt[oi]|faccia|facce|person|sposi|sposa|subject|face|people|portrait|ritratt)/, /\b(schiar|alz|illumin|apr|solleva|lift|bright|rais|light|open|stacc|evidenz|risalt)/],
  },
  {
    intent: 'preserve-highlights',
    all: [/\b(luci|alte luci|highlight|bianch|white|brillant|bright)/, /\b(protegg|preserv|salv|tien|mant|recuper|controll|protect|keep|save|recover|hold|tame|contain)/],
  },
  {
    intent: 'open-shadows',
    all: [/\b(ombr|shadow|scur|dark)/, /\b(apr|schiar|alz|recuper|solleva|open|lift|bright|recover|rais)/],
  },
  {
    intent: 'keep-shadows-deep',
    all: [/\b(ombr|shadow|ner[oie]\b|black|scur|dark)/, /\b(profond|scur|chius|dens|cupo|cupe|deep|dark|crush|rich|moody)/],
  },
  { intent: 'soft-contrast', all: [/\bcontrast/, /\b(bass|morbid|dolc|ridott|meno|lieve|legger|soft|low|less|gentle|flat|subtle)/] },
  { intent: 'punchy-contrast', all: [/\bcontrast/, /\b(alt[oa]|fort|piu|decis|marcat|punch|high|more|strong|bold|crisp)/] },
  { intent: 'expose-correctly', all: [/\b(espo|exposure|expose)/, /\b(corrett|giust|bene|equilibr|right|correct|proper|balanc)/] },
];

/**
 * Phrasings that are negative in form but positive in intent: "don't blow the
 * highlights" asks to preserve them, "non bruciare il cielo" to save the sky.
 */
const NEGATED_RULES: Rule[] = [
  { intent: 'save-the-sky', all: [/\b(ciel|sky)/, /\b(bruc|blow|clip|perd|lose|bianco|white)/] },
  { intent: 'preserve-highlights', all: [/\b(bruc|blow|clip|sovraespo|overexpo|perd|lose)/] },
  { intent: 'keep-shadows-deep', all: [/\b(ombr|shadow|ner|black)/, /\b(apr|schiar|alz|open|lift|grigi|grey|gray|flat|slavat|washed)/] },
];

export function parseIntentText(text: string): ParsedIntents {
  const out: ParsedIntents = { intents: [], matched: [], unmatched: [] };
  for (const clause of clauses(text)) {
    const negated = NEGATION.test(clause);
    let found: string[] = [];
    for (const rule of negated ? NEGATED_RULES : RULES) {
      if (rule.all.every((r) => r.test(clause))) found.push(rule.intent);
    }
    // A clause about the sky's highlights is a sky clause; one about shadows is
    // either opened or deepened, never both.
    if (found.includes('save-the-sky')) found = found.filter((i) => i !== 'preserve-highlights');
    if (found.includes('open-shadows') && found.includes('keep-shadows-deep')) {
      found = found.filter((i) => i !== (/\b(profond|deep|cupo|cupe|chius|crush)/.test(clause) ? 'open-shadows' : 'keep-shadows-deep'));
    }
    if (found.includes('soft-contrast') && found.includes('punchy-contrast')) found = found.filter((i) => i !== 'punchy-contrast');
    if (!found.length) {
      out.unmatched.push(clause);
      continue;
    }
    for (const intent of found) {
      out.matched.push({ clause, intent });
      if (!out.intents.includes(intent)) out.intents.push(intent);
    }
  }
  return out;
}
