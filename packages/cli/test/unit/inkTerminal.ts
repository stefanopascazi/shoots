/**
 * A terminal Ink will talk to, for tests that drive a full-screen component.
 *
 * Real streams, not bare emitters: Ink decodes stdin itself and refs it when it
 * turns raw mode on, so a stubbed `setEncoding` or a missing `ref` silently
 * costs you every keypress.
 *
 * The `debug` flag in {@link renderOptions} is the other half. Ink detects CI
 * and stops drawing frames as they happen, flushing only on unmount — which
 * makes a test that reads the screen pass locally and fail on the runner.
 * `debug: true` writes every frame in full and takes the same path in both.
 */
import { PassThrough } from 'node:stream';

export interface FakeTerminal {
  stdin: PassThrough;
  stdout: PassThrough;
  /** The newest full frame Ink drew (it redraws the screen on every update). */
  screen(): string;
}

export function fakeTerminal(columns = 100, rows = 40): FakeTerminal {
  const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(): void; ref(): void; unref(): void };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};

  const frames: string[] = [];
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
  stdout.columns = columns;
  stdout.rows = rows;
  stdout.write = ((data: string) => {
    frames.push(data);
    return true;
  }) as PassThrough['write'];

  return {
    stdin,
    stdout,
    screen: () => [...frames].reverse().find((frame) => frame.includes('◉')) ?? '',
  };
}

/** Render options every Ink test shares. See the note about `debug` above. */
export function renderOptions(terminal: FakeTerminal): Record<string, unknown> {
  return {
    stdin: terminal.stdin,
    stdout: terminal.stdout,
    exitOnCtrlC: false,
    patchConsole: false,
    debug: true,
  };
}

export const ENTER = '\r';
export const ESC = '';
export const DOWN = '[B';
export const SPACE = ' ';

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until `check` holds. Rendering is asynchronous and a loaded CI runner is
 * slower than a laptop, so waiting on the condition — rather than on a fixed
 * number of milliseconds — is the difference between a test that means
 * something and a test that flakes.
 */
export async function waitFor(check: () => boolean, label: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeout}ms waiting for ${label}`);
    await sleep(10);
  }
}

/**
 * Wait for text to appear on screen, reporting what was there instead.
 *
 * The settle after the match is not padding. Ink paints a frame and only then
 * re-registers the input handler for the new state, so a key sent the instant
 * the frame appears is delivered to the handler that drew it — which is how a
 * space meant for the step list gets swallowed by the question before it.
 */
export async function waitForScreen(
  terminal: FakeTerminal,
  text: string,
  timeout = 10_000,
  settle = 50,
): Promise<void> {
  try {
    await waitFor(() => terminal.screen().includes(text), `'${text}' on screen`, timeout);
  } catch {
    throw new Error(`'${text}' never appeared. Last frame:\n${terminal.screen() || '(nothing drawn)'}`);
  }
  await sleep(settle);
}
