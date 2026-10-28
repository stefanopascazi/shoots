/**
 * Keeping the app server from outliving its users.
 *
 * The page sends a heartbeat while it is open. When none arrives for the idle
 * window the server stops itself, so a closed tab or a Lightroom crash never
 * leaves an orphan process. A running job counts as activity.
 *
 * The session file under ~/.shoots tells the plug-in where a running server is
 * and how to authenticate, so "open app" can reuse it and "close app" can stop it.
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { shootsHome } from '@shoots/core';

export interface IdleWatch {
  /** Record activity now. */
  touch: () => void;
  stop: () => void;
}

export function startIdleWatch(
  timeoutMs: number,
  isBusy: () => boolean,
  onIdle: () => void,
  now: () => number = Date.now,
  checkEveryMs = Math.min(5000, timeoutMs),
): IdleWatch {
  let last = now();
  const timer = setInterval(() => {
    if (isBusy()) last = now();
    else if (now() - last >= timeoutMs) {
      clearInterval(timer);
      onIdle();
    }
  }, checkEveryMs);
  timer.unref?.();
  return { touch: () => (last = now()), stop: () => clearInterval(timer) };
}

export interface AppSession {
  pid: number;
  port: number;
  token: string;
  url: string;
  startedAt: string;
}

export const sessionFilePath = (home: string = shootsHome()): string => path.join(home, 'app.json');

export function writeSession(session: AppSession, file: string = sessionFilePath()): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(session, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}

export function readSession(file: string = sessionFilePath()): AppSession | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as AppSession;
  } catch {
    return undefined;
  }
}

/** Removes the file only if it still describes this process. */
export function clearSession(pid: number, file: string = sessionFilePath()): void {
  if (readSession(file)?.pid === pid) rmSync(file, { force: true });
}
