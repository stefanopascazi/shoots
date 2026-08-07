/** The interactive shell's input tokenizer. */
import { describe, expect, test } from 'bun:test';
import { expandMentions, tokenize } from '../../src/shell/tokenize.js';

describe('tokenize', () => {
  test('splits on runs of whitespace', () => {
    expect(tokenize('cull /photos --top 20')).toEqual(['cull', '/photos', '--top', '20']);
    expect(tokenize('  a\t\tb  ')).toEqual(['a', 'b']);
  });

  test('is empty for blank input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   \t ')).toEqual([]);
  });

  test('keeps a quoted path with spaces in one token, without the quotes', () => {
    expect(tokenize('cull @"raw files/" --threshold 120')).toEqual([
      'cull',
      '@raw files/',
      '--threshold',
      '120',
    ]);
  });

  test('handles both quote styles, each transparent to the other', () => {
    expect(tokenize(`exif --caption "it's fine"`)).toEqual(['exif', '--caption', "it's fine"]);
    expect(tokenize(`exif --caption 'say "hi"'`)).toEqual(['exif', '--caption', 'say "hi"']);
  });

  test('preserves an explicitly empty argument', () => {
    expect(tokenize('rename --pattern ""')).toEqual(['rename', '--pattern', '']);
  });

  test('joins quoted and unquoted halves of the same token', () => {
    expect(tokenize('--dest "my shoot"/keep')).toEqual(['--dest', 'my shoot/keep']);
  });

  test('treats an unterminated quote as running to end of line', () => {
    expect(tokenize('cull "raw files')).toEqual(['cull', 'raw files']);
  });

  test('leaves Windows backslashes alone', () => {
    expect(tokenize('cull C:\\photos\\2026')).toEqual(['cull', 'C:\\photos\\2026']);
  });
});

describe('expandMentions', () => {
  test('strips the leading @ from mention tokens', () => {
    expect(expandMentions(['cull', '@/photos', '--top'])).toEqual(['cull', '/photos', '--top']);
  });

  test('leaves a bare @ alone — it is not a path', () => {
    expect(expandMentions(['@'])).toEqual(['@']);
  });

  test('strips only the first @', () => {
    expect(expandMentions(['@@weird'])).toEqual(['@weird']);
  });

  test('leaves everything else untouched', () => {
    expect(expandMentions(['a@b', '--flag', ''])).toEqual(['a@b', '--flag', '']);
  });
});
