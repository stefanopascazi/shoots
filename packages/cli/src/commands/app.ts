/**
 * `shoots app` — the local web app, started by the Lightroom plug-in.
 *
 * Hidden on purpose: the app is part of the paid plug-in, not of the free CLI,
 * so it is not listed in --help, in the shell or in the docs. The plug-in starts
 * it detached, reads the URL and token from ~/.shoots/app.json, opens the
 * browser itself and keeps a lease alive; without that lease the server stops.
 */
import type { Command } from 'commander';
import { appDbPath, shootsHome } from '@shoots/core';
import { allProfileNames, PROFILE_NAMES } from '@shoots/inference';
import { logError, makeIo, parsePositiveInt } from '../io.js';
import { ensureExiftoolReady } from '../tools.js';
import { VERSION } from '../version.js';
import type { AppServer } from '../app/server.js';
import type { AppStore } from '../app/store.js';

interface AppOptions {
  port: string;
  leaseSeconds: string;
  idleMinutes: string;
}

export function registerAppCommand(program: Command): void {
  program
    .command('app', { hidden: true })
    .description('Serve the local web app for the Lightroom plug-in')
    .option('--port <n>', 'port to bind on 127.0.0.1 (0 picks a free one)', '0')
    .option('--lease-seconds <n>', 'stop when the plug-in has not renewed its lease for this long', '90')
    .option('--idle-minutes <n>', 'stop when no page has been open and nothing has run for this long', '30')
    .action(runApp);
}

async function runApp(options: AppOptions): Promise<void> {
  // Loaded here so commands that never serve the page neither load nor need it built.
  const [{ APP_HTML }, { JobRunner }, { Library }, { clearSession, writeSession }, { createToken }, { createAppServer }, { AppStore }] =
    await Promise.all([
      import('@shoots/app'),
      import('../app/jobs.js'),
      import('../app/library.js'),
      import('../app/lifecycle.js'),
      import('../app/security.js'),
      import('../app/server.js'),
      import('../app/store.js'),
    ]);
  const token = createToken();

  let rawReady: Promise<boolean> | undefined;
  const library = new Library(() => (rawReady ??= ensureExiftoolReady(makeIo({}))));
  let store: AppStore;
  try {
    store = await AppStore.open(appDbPath());
  } catch (err) {
    logError(`could not open the app database: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  // Finished jobs are stored by the server, which is created just below.
  let app: AppServer | undefined;
  const jobs = new JobRunner(undefined, (status) => app?.jobFinished(status));

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  app = createAppServer({
    html: APP_HTML,
    token,
    info: { version: VERSION, platform: process.platform, home: shootsHome() },
    library,
    jobs,
    store,
    profiles: async () => {
      const builtin = new Set(PROFILE_NAMES);
      return (await allProfileNames()).map((name) => ({ name, learned: !builtin.has(name) }));
    },
    hostLeaseMs: parsePositiveInt(options.leaseSeconds, 90) * 1000,
    pageIdleMs: parsePositiveInt(options.idleMinutes, 30) * 60_000,
    onStop: (reason) => {
      clearSession(process.pid);
      store.close();
      process.stderr.write(`shoots app stopped (${reason})\n`);
      resolveDone();
    },
  });

  let port: number;
  try {
    port = await app.listen(Number.parseInt(options.port, 10) || 0);
  } catch (err) {
    logError(`could not start the app server: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const url = `http://127.0.0.1:${port}/?t=${token}`;
  writeSession({ pid: process.pid, port, token, url, startedAt: new Date().toISOString() });
  process.stderr.write(`shoots app listening on http://127.0.0.1:${port}\n`);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => app!.stop('shutdown'));
  await done;
}
