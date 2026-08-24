/**
 * The Ink front-end of `pipeline init`, driven through a fake terminal.
 *
 * It renders whatever the wizard hands it, so there is little per-question logic
 * to test — but there is a keyboard, and a keyboard is where this kind of screen
 * breaks: enter must take the default, arrows and space must actually change the
 * selection, esc must undo an answer rather than the whole run, and nothing may
 * be handed back until the review screen is confirmed.
 */
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { render } from 'ink';
import { makeContext, type Answers } from '@shoots/core';
import { InitWizard } from '../../src/pipeline/init/InitWizard.js';
import { DOWN, ENTER, ESC, SPACE, fakeTerminal, sleep } from './inkTerminal.js';

const CONTEXT = makeContext({ profiles: ['generic', 'wedding'], editors: ['acr'], labels: ['reject'] });

interface Session {
  press(input: string): Promise<void>;
  result(): Answers | null;
  screen(): string;
  /** Let the last keypress settle and tear the app down. */
  done(): Promise<void>;
}

function start(initial: Answers = {}): Session {
  const terminal = fakeTerminal();
  let result: Answers | null = null;
  let settled = false;

  const app = render(
    createElement(InitWizard, {
      context: CONTEXT,
      initial,
      fileName: 'p.yaml',
      exists: false,
      onDone: (answers: Answers | null) => {
        result = answers;
        settled = true;
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { stdin: terminal.stdin as any, stdout: terminal.stdout as any, exitOnCtrlC: false, patchConsole: false },
  );

  return {
    async press(input: string) {
      if (settled) return;
      terminal.stdin.write(input);
      await sleep(45);
    },
    result: () => result,
    screen: terminal.screen,
    done: async () => {
      await sleep(60);
      app.unmount();
    },
  };
}

const ENTER = '\r';

/** Enter until the review screen appears (or the safety bound is hit). */
async function pressThrough(session: Session, times = 20): Promise<void> {
  for (let i = 0; i < times && !session.screen().includes('This is p.yaml'); i += 1) {
    await session.press(ENTER);
  }
}

describe('the Ink wizard', () => {
  test('enter through every question reaches the review screen, and y writes', async () => {
    const session = start();
    await sleep(60);
    expect(session.screen()).toContain('What are you setting up?');

    await pressThrough(session);
    expect(session.screen()).toContain('This is p.yaml');
    expect(session.screen()).toContain('version: 2');

    await session.press('y');
    await session.done();

    const answers = session.result()!;
    expect(answers.intent).toBe('shoot');
    expect(answers.coverage).toBe('all');
  }, 20_000);

  test('nothing is handed back until the review screen is confirmed', async () => {
    const session = start();
    await sleep(60);
    await pressThrough(session);
    expect(session.result()).toBeNull(); // on the review screen, still nothing

    await session.press('n');
    await session.done();
    expect(session.result()).toBeNull();
  }, 20_000);

  test('arrows move the selection and space toggles a step', async () => {
    const session = start();
    await sleep(60);

    await session.press(ENTER); // intent: work on a shoot
    await session.press(DOWN); // coverage → pick the steps
    await session.press(ENTER);
    await session.press(SPACE); // steps: toggle the first choice (import) on
    await session.press(ENTER);
    await sleep(60);

    const screen = session.screen();
    expect(screen).toContain('Card or source folder'); // import was really added

    await pressThrough(session);
    await session.press('y');
    await session.done();

    const answers = session.result()!;
    expect(answers.coverage).toBe('pick');
    expect(answers.steps).toContain('import');
    expect(answers.steps).toContain('rate');
  }, 20_000);

  test('esc steps back one answer, and cancels outright on the first question', async () => {
    const session = start();
    await sleep(60);
    await session.press(ENTER); // intent answered
    await session.press(ENTER); // coverage answered
    expect(session.screen()).toContain('Shoot folder');

    await session.press(ESC);
    await sleep(60);
    expect(session.screen()).toContain('The whole pass'); // back on the previous question

    await session.press(ESC); // back to the intent
    await session.press(ESC); // nothing left to undo: cancel
    await session.done();
    expect(session.result()).toBeNull();
  }, 20_000);
});
