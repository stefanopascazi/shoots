/**
 * The line-by-line front-end of `pipeline init`.
 *
 * The wizard's logic is tested in core; what matters here is the part a
 * terminal usually hides: pressing enter through every question must produce a
 * complete answer sheet, a mistyped answer must re-ask instead of being stored,
 * and an input stream that ends must abandon the run rather than write a file
 * nobody confirmed.
 */
import { describe, expect, test } from 'bun:test';
import { makeContext, buildDraft, type Answers } from '@shoots/core';
import { confirm, runPlainWizard, type LineReader } from '../../src/pipeline/init/plainPrompt.js';

/** The wizard's own printing is not under test; keep the suite output clean. */
const silent = (): void => {};

const CONTEXT = makeContext({ profiles: ['generic', 'wedding'], editors: ['acr'], labels: ['reject'] });

/** A reader that replays a script; `null` entries end the input. */
function scripted(lines: Array<string | null>): LineReader & { asked: string[] } {
  const asked: string[] = [];
  let index = 0;
  return {
    asked,
    async ask(prompt: string) {
      asked.push(prompt);
      return index < lines.length ? lines[index++]! : null;
    },
    close() {},
  };
}

/** Enter, forever: every question takes its default. */
const allDefaults = (): LineReader => ({
  async ask() {
    return '';
  },
  close() {},
});

describe('the plain wizard', () => {
  test('pressing enter through it answers every question with its default', async () => {
    const answers = (await runPlainWizard(CONTEXT, allDefaults(), {}, silent)) as Answers;
    expect(answers).not.toBeNull();
    expect(answers.intent).toBe('shoot');
    expect(answers.coverage).toBe('all');
    expect(buildDraft(answers, CONTEXT).steps.map((s) => s.run)).toEqual([
      'import',
      'rename',
      'exif',
      'rate',
      'cull',
      'develop edit',
    ]);
  });

  test('answers are read, not assumed', async () => {
    const reader = scripted([
      '1', // intent: work on a shoot
      'pick', // coverage: particular steps
      '1, 4', // steps: import, rate
      'E:/DCIM', // vars.card
      'D:/Shoots/smith', // vars.shoot
    ]);
    const answers = (await runPlainWizard(CONTEXT, reader, {}, silent)) as Answers;
    expect(answers.intent).toBe('shoot');
    expect(answers.steps).toEqual(['import', 'rate']);
    expect(answers['vars.card']).toBe('E:/DCIM');
    expect(answers['vars.shoot']).toBe('D:/Shoots/smith');
  });

  test('training asks two questions and stops', async () => {
    const reader = scripted(['train', 'D:/Shoots/edited']);
    const answers = (await runPlainWizard(CONTEXT, reader, {}, silent)) as Answers;
    expect(answers['vars.shoot']).toBe('D:/Shoots/edited');
    expect(reader.asked).toHaveLength(2);
  });

  test('an unknown choice is re-asked instead of stored', async () => {
    const reader = scripted(['nonsense', 'train', '']);
    const answers = (await runPlainWizard(CONTEXT, reader, {}, silent)) as Answers;
    expect(answers.intent).toBe('train');
    // The rejected line cost one extra prompt for the same question.
    expect(reader.asked).toHaveLength(3);
  });

  test('input that ends mid-wizard abandons it — no partial file', async () => {
    expect(await runPlainWizard(CONTEXT, scripted(['1', 'all']), {}, silent)).toBeNull();
  });

  test('pre-answered questions are not asked again', async () => {
    const prompts: string[] = [];
    const reader: LineReader = {
      async ask(prompt: string) {
        prompts.push(prompt);
        return '';
      },
      close() {},
    };
    const answers = (await runPlainWizard(CONTEXT, reader, { 'vars.shoot': 'D:/given' }, silent)) as Answers;
    expect(answers['vars.shoot']).toBe('D:/given');
    // The shoot question shows its default in the prompt; it was never printed.
    expect(prompts.some((prompt) => prompt.includes('D:/Shoots/my-shoot'))).toBe(false);
  });

  test('the final confirmation defaults to yes but takes no for an answer', async () => {
    expect(await confirm(scripted(['']), 'Write?')).toBe(true);
    expect(await confirm(scripted(['n']), 'Write?')).toBe(false);
    expect(await confirm(scripted([null]), 'Write?')).toBe(false); // ended input is not consent
  });
});
