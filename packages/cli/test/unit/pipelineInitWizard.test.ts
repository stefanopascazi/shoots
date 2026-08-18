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
import { PassThrough } from 'node:stream';
import { createElement } from 'react';
import { render } from 'ink';
import { makeContext, type Answers } from '@shoots/core';
import { InitWizard } from '../../src/pipeline/init/InitWizard.js';

const CONTEXT = makeContext({ profiles: ['generic', 'wedding'], editors: ['acr'], labels: ['reject'] });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Just enough of a TTY for Ink. A real stream, not a bare emitter: Ink decodes
 * stdin itself, so a stubbed `setEncoding` would silently hand it Buffers and
 * every keypress would be dropped.
 */
function fakeTerminal() {
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode(): void;
    ref(): void;
    unref(): void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {}; // Ink refs stdin when it turns raw mode on
  stdin.unref = () => {};

  // Only the newest frame is interesting: Ink redraws the whole screen on every
  // update, so accumulating them would make every assertion pass on history.
  const frames: string[] = [];
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
  stdout.columns = 100;
  stdout.rows = 40;
  stdout.write = ((data: string) => {
    frames.push(data);
    return true;
  }) as PassThrough['write'];

  const screen = (): string => [...frames].reverse().find((frame) => frame.includes('◉')) ?? '';
  return { stdin, stdout, screen };
}

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
const DOWN = '[B';
const ESC = '';
const SPACE = ' ';

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
    expect(session.screen()).toContain('What should this pipeline do?');

    await pressThrough(session);
    expect(session.screen()).toContain('This is p.yaml');
    expect(session.screen()).toContain('version: 2');

    await session.press('y');
    await session.done();

    const answers = session.result()!;
    expect(answers.preset).toBe('ingest');
    expect(answers.steps).toEqual(['import', 'rename', 'exif', 'rate', 'cull', 'develop-edit']);
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

    await session.press(DOWN); // preset → cull & rate
    await session.press(ENTER);
    await session.press(ENTER); // name: default
    await session.press(SPACE); // steps: toggle the first choice (import) on
    await session.press(ENTER);
    await sleep(60);

    const screen = session.screen();
    expect(screen).toContain('Card or source folder'); // import was really added

    await pressThrough(session);
    await session.press('y');
    await session.done();

    const answers = session.result()!;
    expect(answers.preset).toBe('cull-rate');
    expect(answers.steps).toContain('import');
    expect(answers.steps).toContain('rate');
  }, 20_000);

  test('esc steps back one answer, and cancels outright on the first question', async () => {
    const session = start();
    await sleep(60);
    await session.press(ENTER); // preset answered
    await session.press(ENTER); // name answered
    expect(session.screen()).toContain('Which steps should it run?');

    await session.press(ESC);
    await sleep(60);
    expect(session.screen()).toContain('Pipeline name'); // back on the previous question

    await session.press(ESC); // back to the preset
    await session.press(ESC); // nothing left to undo: cancel
    await session.done();
    expect(session.result()).toBeNull();
  }, 20_000);
});
