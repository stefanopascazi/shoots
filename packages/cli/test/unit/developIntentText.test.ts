import { describe, expect, test } from 'bun:test';
import { parseIntentText } from '../../src/develop/intents/text.js';

const ids = (text: string): string[] => parseIntentText(text).intents;

describe('parseIntentText — Italian', () => {
  test.each([
    ['Salva il cielo', ['save-the-sky']],
    ['proteggi le luci', ['preserve-highlights']],
    ['apri un po’ le ombre', ['open-shadows']],
    ['ombre profonde', ['keep-shadows-deep']],
    ['contrasto basso', ['soft-contrast']],
    ['più contrasto', ['punchy-contrast']],
    ["esponi correttamente", ['expose-correctly']],
    ["l'esposizione deve essere giusta", ['expose-correctly']],
    ['schiarisci il soggetto', ['lift-the-subject']],
    ['illumina i visi degli sposi', ['lift-the-subject']],
  ])('%s', (text, expected) => {
    expect(ids(text)).toEqual(expected);
  });

  test('a whole request, split into its clauses', () => {
    expect(ids('Salva il cielo e apri un po’ le ombre, contrasto morbido')).toEqual(['save-the-sky', 'open-shadows', 'soft-contrast']);
  });

  test('negative in form, positive in intent', () => {
    expect(ids('non bruciare le luci')).toEqual(['preserve-highlights']);
    expect(ids('non bruciare il cielo')).toEqual(['save-the-sky']);
    expect(ids('non aprire troppo le ombre')).toEqual(['keep-shadows-deep']);
  });

  test('the sky’s highlights are a sky request', () => {
    expect(ids('recupera le luci del cielo')).toEqual(['save-the-sky']);
  });
});

describe('parseIntentText — English', () => {
  test.each([
    ['protect the highlights', ['preserve-highlights']],
    ['lift the shadows', ['open-shadows']],
    ['keep the shadows deep and moody', ['keep-shadows-deep']],
    ['low contrast', ['soft-contrast']],
    ['punchy, more contrast', ['punchy-contrast']],
    ['save the sky', ['save-the-sky']],
    ["don't blow the highlights", ['preserve-highlights']],
    ['brighten the faces', ['lift-the-subject']],
  ])('%s', (text, expected) => {
    expect(ids(text)).toEqual(expected);
  });
});

describe('what it does not understand', () => {
  test('is reported clause by clause, not guessed', () => {
    const p = parseIntentText('Proteggi le luci, rendilo vintage');
    expect(p.intents).toEqual(['preserve-highlights']);
    expect(p.unmatched).toEqual(['rendilo vintage']);
  });

  test('shows which clause produced which intent', () => {
    expect(parseIntentText('Salva il cielo').matched).toEqual([{ clause: 'salva il cielo', intent: 'save-the-sky' }]);
  });

  test('empty text, nothing', () => {
    expect(parseIntentText('   ')).toEqual({ intents: [], matched: [], unmatched: [] });
  });
});
