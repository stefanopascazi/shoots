/** Pure pieces of the dev launcher, kept apart so they can be tested. */

export interface AppSession {
  pid: number;
  port: number;
  token: string;
  url: string;
}

/** How to open a URL in the default browser on each platform. */
export function openCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  if (platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

/**
 * Polls `read` until it returns the session written by process `pid`, so a stale
 * file left by an earlier server is never mistaken for the new one.
 */
export async function waitForSession(
  read: () => AppSession | undefined,
  pid: number,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  stepMs = 250,
): Promise<AppSession | undefined> {
  for (let waited = 0; waited <= timeoutMs; waited += stepMs) {
    const s = read();
    if (s?.pid === pid) return s;
    await sleep(stepMs);
  }
  return undefined;
}
