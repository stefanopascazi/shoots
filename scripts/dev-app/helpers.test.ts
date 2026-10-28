import { describe, expect, test } from 'bun:test';
import { openCommand, waitForSession, type AppSession } from './helpers.js';

describe('openCommand', () => {
  test('one opener per platform', () => {
    expect(openCommand('win32', 'http://x')).toEqual(['rundll32', ['url.dll,FileProtocolHandler', 'http://x']]);
    expect(openCommand('darwin', 'http://x')).toEqual(['open', ['http://x']]);
    expect(openCommand('linux', 'http://x')).toEqual(['xdg-open', ['http://x']]);
  });
});

describe('waitForSession', () => {
  const session = (pid: number): AppSession => ({ pid, port: 1, token: 't', url: 'u' });
  const noSleep = async () => {};

  test('ignores a stale session until the new process writes its own', async () => {
    const reads = [undefined, session(1), session(2)];
    let i = 0;
    const found = await waitForSession(() => reads[Math.min(i++, reads.length - 1)], 2, 10_000, noSleep);
    expect(found?.pid).toBe(2);
  });

  test('gives up after the timeout', async () => {
    expect(await waitForSession(() => session(1), 2, 1000, noSleep)).toBeUndefined();
  });
});
