/**
 * Runs the shoots app on a machine without Lightroom, for development.
 *
 *   npm run app:dev              build ui, app and cli, then start
 *   npm run app:dev -- --no-build
 *   npm run app:dev -- --no-open    print the URL instead of opening a browser
 *
 * It does what the plug-in does and nothing more: starts the hidden `app`
 * command from the dev build, holds its lease with a heartbeat, opens the
 * browser on the launch URL, and shuts the server down on Ctrl+C. It lives in
 * scripts/, so it never ships in the binary.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { openCommand, waitForSession, type AppSession } from './helpers.js';

const root = path.resolve(import.meta.dir, '..', '..');
const args = process.argv.slice(2);
const LEASE_EVERY_MS = 30_000;

if (!args.includes('--no-build')) {
  const build = spawnSync('npm', ['run', 'build', '-w', '@shoots/ui', '-w', '@shoots/app', '-w', '@shoots/cli'], {
    cwd: root,
    stdio: 'inherit',
    shell: true,
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const sessionFile = path.join(process.env.SHOOTS_HOME ?? path.join(homedir(), '.shoots'), 'app.json');
const readSession = (): AppSession | undefined => {
  try {
    return JSON.parse(readFileSync(sessionFile, 'utf8')) as AppSession;
  } catch {
    return undefined;
  }
};

const server = spawn('node', [path.join(root, 'packages', 'cli', 'dist', 'cli.js'), 'app'], {
  cwd: root,
  stdio: ['ignore', 'inherit', 'inherit'],
});
server.on('exit', (code) => process.exit(code ?? 0));

const session = await waitForSession(readSession, server.pid!, 20_000);
if (!session) {
  console.error('The app server did not start.');
  server.kill();
  process.exit(1);
}

const post = (route: string) =>
  fetch(`http://127.0.0.1:${session.port}${route}`, { method: 'POST', headers: { 'x-shoots-token': session.token } }).catch(
    () => undefined,
  );

await post('/api/host/heartbeat');
setInterval(() => void post('/api/host/heartbeat'), LEASE_EVERY_MS);

if (!args.includes('--no-open')) {
  const [cmd, cmdArgs] = openCommand(process.platform, session.url);
  spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' }).unref();
}
console.log(`shoots app (dev) at ${session.url}\nCtrl+C to stop.`);

process.on('SIGINT', async () => {
  await post('/api/shutdown');
  setTimeout(() => process.exit(0), 1000);
});
