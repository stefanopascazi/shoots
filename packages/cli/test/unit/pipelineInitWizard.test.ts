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
import {
  DOWN,
  ENTER,
  ESC,
  SPACE,
  fakeTerminal,
  renderOptions,
  sleep,
  waitFor,
  waitForScreen,
  type FakeTerminal,
} from './inkTerminal.js';

const CONTEXT = makeContext({ profiles: ['generic', 'wedding'], editors: ['acr'], labels: ['reject'] });

interface Session {
  press(input: string): Promise<void>;
  /** Wait for text to reach the screen — rendering is asynchronous. */
  expectScreen(text: string): Promise<void>;
  /** Wait for the wizard to hand its answers back (or to refuse to). */
  settled(): Promise<void>;
  result(): Answers | null;
  screen(): string;
  /** Tear the app down. */
  done(): Promise<void>;
}

function start(initial: Answers = {}): Session {
  const terminal: FakeTerminal = fakeTerminal();
  let result: Answers | null = null;
  let finished = false;

  const app = render(
    createElement(InitWizard, {
      context: CONTEXT,
      initial,
      fileName: 'p.yaml',
      exists: false,
      onDone: (answers: Answers | null) => {
        result = answers;
        finished = true;
      },
    }),
    renderOptions(terminal),
  );

  return {
    async press(input: string) {
      if (finished) return;
      terminal.stdin.write(input);
      await sleep(20); // let the keypress land; the assertions do the waiting
    },
    expectScreen: (text: string) => waitForScreen(terminal, text),
    settled: () => waitFor(() => finished, 'the wizard to finish'),
    result: () => result,
    screen: terminal.screen,
    done: async () => {
      await sleep(20);
      app.unmount();
    },
  };
}

/** Enter until the review screen appears (or the safety bound is hit). */
async function pressThrough(session: Session, times = 20): Promise<void> {
  for (let i = 0; i < times && !session.screen().includes('This is p.yaml'); i += 1) {
    await session.press(ENTER);
    await sleep(20);
  }
  await session.expectScreen('This is p.yaml');
}

describe('the Ink wizard', () => {
  test('enter through every question reaches the review screen, and y writes', async () => {
    const session = start();
    await session.expectScreen('What are you setting up?');

    await pressThrough(session);
    expect(session.screen()).toContain('version: 2');

    await session.press('y');
    await session.settled();
    await session.done();

    const answers = session.result()!;
    expect(answers.intent).toBe('shoot');
    expect(answers.coverage).toBe('all');
  }, 20_000);

  test('nothing is handed back until the review screen is confirmed', async () => {
    const session = start();
    await session.expectScreen('What are you setting up?');
    await pressThrough(session);
    expect(session.result()).toBeNull(); // on the review screen, still nothing

    await session.press('n');
    await session.settled();
    await session.done();
    expect(session.result()).toBeNull();
  }, 20_000);

  test('arrows move the selection and space toggles a step', async () => {
    const session = start();
    await session.expectScreen('What are you setting up?');

    await session.press(ENTER); // intent: work on a shoot
    await session.press(DOWN); // coverage → pick the steps
    await session.press(ENTER);
    await session.expectScreen('Which steps?');
    await session.press(SPACE); // steps: toggle the first choice (import) off
    // Wait for the toggle to render: pressing enter before the component has
    // re-rendered would commit the selection the handler closed over.
    await session.expectScreen('[ ] import');
    await session.press(ENTER);

    // Dropping the offload drops the question only the offload needed.
    await session.expectScreen('Shoot folder');
    expect(session.screen()).not.toContain('Card or source folder');

    await pressThrough(session);
    await session.press('y');
    await session.settled();
    await session.done();

    const answers = session.result()!;
    expect(answers.coverage).toBe('pick');
    expect(answers.steps).not.toContain('import');
    expect(answers.steps).toContain('rate');
  }, 20_000);

  test('esc steps back one answer, and cancels outright on the first question', async () => {
    const session = start();
    await session.expectScreen('What are you setting up?');
    await session.press(ENTER); // intent answered
    await session.press(ENTER); // coverage answered
    await session.expectScreen('Card or source folder');

    await session.press(ESC);
    await session.expectScreen('The whole pass'); // back on the previous question

    await session.press(ESC); // back to the intent
    await session.expectScreen('What are you setting up?');
    await session.press(ESC); // nothing left to undo: cancel
    await session.settled();
    await session.done();
    expect(session.result()).toBeNull();
  }, 20_000);
});
