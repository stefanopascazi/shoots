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
    expect(answers.preset).toBe('ingest');
    expect(answers.steps).toEqual(['import', 'rename', 'exif', 'rate', 'cull', 'develop-edit']);
    expect(buildDraft(answers, CONTEXT).steps).toHaveLength(6);
  });

  test('answers are read, not assumed: a chosen preset and picked steps both land', async () => {
    const reader = scripted([
      '2', // preset: cull & rate
      'my-cull', // name
      '4,5', // steps: rate, cull
      'D:/Shoots/on-disk', // vars.raw
      'wedding', // rate.profile
      'n', // rate.mark
      '250', // cull.threshold
      '', // cull.label (default)
    ]);
    const answers = (await runPlainWizard(CONTEXT, reader, {}, silent)) as Answers;
    expect(answers.preset).toBe('cull-rate');
    expect(answers.name).toBe('my-cull');
    expect(answers.steps).toEqual(['rate', 'cull']);
    expect(answers['rate.profile']).toBe('wedding');
    expect(answers['rate.mark']).toBe(false);
    expect(answers['cull.threshold']).toBe('250');
  });

  test('an unknown choice is re-asked instead of stored', async () => {
    const reader = scripted(['nonsense', '4', 'x', '4', '', '', '', '']);
    const answers = (await runPlainWizard(CONTEXT, reader, {}, silent)) as Answers;
    expect(answers.preset).toBe('custom');
    // The rejected line cost one extra prompt for the same question.
    expect(reader.asked.length).toBeGreaterThan(4);
  });

  test('input that ends mid-wizard abandons it — no partial file', async () => {
    expect(await runPlainWizard(CONTEXT, scripted(['1', 'name']), {}, silent)).toBeNull();
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
