/**
 * A terminal Ink will talk to, for tests that drive a full-screen component.
 *
 * Real streams, not bare emitters: Ink decodes stdin itself and refs it when it
 * turns raw mode on, so a stubbed `setEncoding` or a missing `ref` silently
 * costs you every keypress.
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

export const ENTER = '\r';
export const ESC = '';
export const DOWN = '[B';
export const SPACE = ' ';

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
