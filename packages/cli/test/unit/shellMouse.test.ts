/**
 * The mouse-wheel bridge between the real stdin and Ink.
 *
 * Two things matter here. Keystrokes must pass through untouched while mouse
 * reports are stripped and turned into scroll events — junk in the input box is
 * the failure that motivated the filter in the first place. And `stop()` must
 * hand stdin back the way it found it: listening put it into flowing mode and
 * Ink put it into raw mode, and a stdin left in either state is a live handle
 * that keeps the process running after `/exit`.
 */
import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';

import { createMouseWheel } from '../../src/shell/mouse.js';

interface FakeStdin extends PassThrough {
  isTTY: boolean;
  rawMode: boolean | null;
  paused: boolean;
  setRawMode(mode: boolean): FakeStdin;
  ref(): FakeStdin;
  unref(): FakeStdin;
}

/** A stdin that records what was done to it. */
function fakeStdin(): FakeStdin {
  const stream = new PassThrough() as FakeStdin;
  stream.isTTY = true;
  stream.rawMode = null;
  stream.paused = false;
  stream.setRawMode = (mode: boolean) => {
    stream.rawMode = mode;
    return stream;
  };
  stream.ref = () => stream;
  stream.unref = () => stream;
  const realPause = stream.pause.bind(stream);
  stream.pause = () => {
    stream.paused = true;
    return realPause();
  };
  return stream;
}

/** Collect what Ink would have read from the filtered stream. */
function readable(mouse: ReturnType<typeof createMouseWheel>): () => string {
  let seen = '';
  (mouse.stdin as unknown as PassThrough).on('data', (chunk: Buffer) => {
    seen += chunk.toString('utf8');
  });
  return () => seen;
}

const WHEEL_UP = '[<64;10;5M';
const WHEEL_DOWN = '[<65;10;5M';

describe('the wheel filter', () => {
  test('keystrokes pass through and mouse reports do not', async () => {
    const source = fakeStdin();
    const mouse = createMouseWheel(source as unknown as NodeJS.ReadStream);
    const seen = readable(mouse);
    mouse.start();

    source.write(`ab${WHEEL_UP}cd`);
    await new Promise((resolve) => setImmediate(resolve));

    expect(seen()).toBe('abcd');
    mouse.stop();
  });

  test('a wheel report becomes a signed scroll delta', async () => {
    const source = fakeStdin();
    const mouse = createMouseWheel(source as unknown as NodeJS.ReadStream);
    const deltas: number[] = [];
    mouse.events.on('scroll', (delta: number) => deltas.push(delta));
    mouse.start();

    source.write(WHEEL_UP + WHEEL_DOWN);
    await new Promise((resolve) => setImmediate(resolve));

    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toBeLessThan(0); // up scrolls back
    expect(deltas[1]).toBeGreaterThan(0);
    mouse.stop();
  });
});

describe('tearing it down', () => {
  test('stop() leaves stdin out of raw mode and paused, so the process can exit', () => {
    const source = fakeStdin();
    const mouse = createMouseWheel(source as unknown as NodeJS.ReadStream);
    mouse.start();
    (mouse.stdin as unknown as { setRawMode(mode: boolean): void }).setRawMode(true);
    expect(source.rawMode).toBe(true);

    mouse.stop();

    expect(source.rawMode).toBe(false);
    expect(source.paused).toBe(true);
    expect(source.listenerCount('data')).toBe(0);
  });

  test('stop() is safe to call twice', () => {
    const source = fakeStdin();
    const mouse = createMouseWheel(source as unknown as NodeJS.ReadStream);
    mouse.start();
    mouse.stop();
    expect(() => mouse.stop()).not.toThrow();
  });

  test('after stop() nothing else reaches Ink', async () => {
    const source = fakeStdin();
    const mouse = createMouseWheel(source as unknown as NodeJS.ReadStream);
    const seen = readable(mouse);
    mouse.start();
    mouse.stop();

    source.write('late');
    await new Promise((resolve) => setImmediate(resolve));

    expect(seen()).toBe('');
  });
});
