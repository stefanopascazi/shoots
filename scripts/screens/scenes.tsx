/**
 * The screens we publish. Each scene captures *real* output — either by driving
 * the actual Ink UI with keystrokes, or by running the built CLI — and never by
 * hand-writing the text it shows.
 *
 * The Ink components are loaded from `packages/cli/dist` rather than from source
 * on purpose: that is the code the released binary runs (version literals baked
 * in), and it lets the shell's own `runCli` find its sibling `cli.js` when a
 * scene executes a command for real.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ComponentType } from 'react';
import { ProgressTracker } from '../../packages/cli/src/progress.js';
import type { ProgressViewProps } from '../../packages/cli/src/components/ProgressView.js';
import type { ShellProps } from '../../packages/cli/src/shell/Shell.js';
import { parseAnsi, trim, type Screen } from './ansi.js';
import { inkSession, KEY, runCommand, withPrompt } from './harness.js';

export interface SceneContext {
  /** Path to the built CLI entry (`packages/cli/dist/cli.js`). */
  cliPath: string;
  /** Working directory the scenes run in: holds `raw/` with real photographs. */
  demoDir: string;
  /** Relative folder inside `demoDir` that contains the photographs. */
  rawDir: string;
}

export interface Scene {
  name: string;
  title: string;
  description: string;
  /** Skip the scene when no photographs are available to work on. */
  needsImages?: boolean;
  /** Returns the final screen, or null when the scene cannot be captured. */
  capture(ctx: SceneContext): Promise<Screen | null>;
}

const screenOf = (stream: string, cols: number, rows: number) => trim(parseAnsi(stream, cols, rows));

/**
 * Resolves a code-split chunk by prefix (tsup content-hashes the file name) and
 * returns the named export.
 */
async function loadBuilt<T>(distDir: string, prefix: string, exportName: string): Promise<T> {
  const file = readdirSync(distDir).find((f) => f.startsWith(`${prefix}-`) && f.endsWith('.js'));
  if (!file) throw new Error(`no built ${prefix} chunk in ${distDir} — run \`npm run build\``);
  const mod = await import(pathToFileURL(path.join(distDir, file)).href);
  const value = mod[exportName];
  if (!value) throw new Error(`${file} does not export ${exportName}`);
  return value as T;
}

const distOf = (ctx: SceneContext) => path.dirname(ctx.cliPath);

interface ShellSceneOptions {
  cols: number;
  rows: number;
  /** Run the shell in the demo catalog so cwd and mentions show real photos. */
  inDemo?: boolean;
}

/** Shell scenes share the mount + settle dance; only the typing differs. */
async function shellScene(
  ctx: SceneContext,
  { cols, rows, inDemo = true }: ShellSceneOptions,
  drive: (session: ReturnType<typeof inkSession>) => Promise<void>,
): Promise<Screen> {
  const Shell = await loadBuilt<ComponentType<ShellProps>>(distOf(ctx), 'Shell', 'Shell');

  // Shell sizes its viewport from process.stdout (not from Ink's stdout) and
  // reads its cwd from the process, so the capture geometry and location have to
  // be visible there too.
  const restore = { columns: process.stdout.columns, rows: process.stdout.rows, cwd: process.cwd() };
  Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
  if (inDemo) process.chdir(ctx.demoDir);

  const session = inkSession(<Shell />, { cols, rows });
  try {
    await session.wait(900); // first paint + exiftool probe
    await drive(session);
    return screenOf(session.stream(), cols, rows);
  } finally {
    session.stop();
    process.chdir(restore.cwd);
    Object.defineProperty(process.stdout, 'columns', { value: restore.columns, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: restore.rows, configurable: true });
  }
}

export const SCENES: Scene[] = [
  {
    name: 'shell',
    title: 'shoots',
    description: 'The interactive shell as it opens: wordmark, environment line, empty prompt.',
    capture: (ctx) => shellScene(ctx, { cols: 92, rows: 16 }, async () => {}),
  },

  {
    name: 'palette',
    title: 'shoots — command palette',
    description: 'Typing "/" opens the command palette with live autocomplete.',
    capture: (ctx) =>
      shellScene(ctx, { cols: 92, rows: 22 }, async (session) => {
        await session.type('/');
      }),
  },

  {
    name: 'mentions',
    title: 'shoots — file mentions',
    description: 'Typing "@" completes real paths from the filesystem.',
    needsImages: true,
    capture: (ctx) =>
      shellScene(ctx, { cols: 92, rows: 18 }, async (session) => {
        await session.type(...'/cull @'.split(''));
      }),
  },

  {
    name: 'run',
    title: 'shoots — a command in the shell',
    description: 'A real cull executed from the shell, output streamed into its scrollback.',
    needsImages: true,
    capture: (ctx) =>
      shellScene(ctx, { cols: 100, rows: 20 }, async (session) => {
        await session.type(...`/cull ${ctx.rawDir}`.split(''), KEY.enter);
        // The summary line is the last thing cull prints.
        await session.waitFor((stream) => /analyzed @ threshold/.test(stream), 180_000);
        await session.wait(400);
      }),
  },

  {
    name: 'review',
    title: 'shoots — interactive review',
    description: 'Human-in-the-loop review of the uncertain shallow-DoF rescues.',
    needsImages: true,
    async capture(ctx) {
      let sawCard = false;
      const screen = await shellScene(ctx, { cols: 100, rows: 20 }, async (session) => {
        await session.type(...`/cull ${ctx.rawDir} --review --dest rejects --dry-run`.split(''), KEY.enter);
        // Analysis first, then the first review card (only rescued frames queue).
        sawCard = await session.waitFor((stream) => /uncertain —/.test(stream), 240_000);
        await session.wait(400);
      });
      // No shallow-DoF rescues in this catalog: nothing to show, so publish nothing.
      return sawCard ? screen : null;
    },
  },

  {
    name: 'cull',
    title: 'shoots — cull',
    description: 'A real focus-aware cull run: per-frame scores and the summary line.',
    needsImages: true,
    async capture(ctx) {
      const args = ['cull', ctx.rawDir];
      const { stream } = await runCommand(ctx.cliPath, args, {
        cols: 100,
        cwd: ctx.demoDir,
        expectSuccess: true,
      });
      return screenOf(withPrompt(`shoots ${args.join(' ')}`, stream), 100, 20);
    },
  },

  {
    name: 'rate',
    title: 'shoots — rate',
    description: 'Local CLIP scoring: stars and keywords written to sidecars.',
    needsImages: true,
    async capture(ctx) {
      const args = ['rate', ctx.rawDir, '--profile', 'wedding'];
      const { stream } = await runCommand(ctx.cliPath, args, {
        cols: 118,
        cwd: ctx.demoDir,
        expectSuccess: true,
      });
      return screenOf(withPrompt(`shoots ${args.join(' ')}`, stream), 118, 20);
    },
  },

  {
    name: 'doctor',
    title: 'shoots — doctor',
    description: 'Environment health check: tools and model provisioned under ~/.shoots.',
    async capture(ctx) {
      const { stream } = await runCommand(ctx.cliPath, ['doctor'], {
        cols: 118,
        expectSuccess: true,
      });
      return screenOf(withPrompt('shoots doctor', stream), 118, 16);
    },
  },

  {
    name: 'help',
    title: 'shoots — help',
    description: 'The command surface at a glance.',
    async capture(ctx) {
      const { stream } = await runCommand(ctx.cliPath, ['--help'], {
        cols: 96,
        expectSuccess: true,
      });
      return screenOf(withPrompt('shoots --help', stream), 96, 44);
    },
  },

  {
    name: 'progress',
    title: 'shoots — progress',
    description: 'The Ink progress view mid-job.',
    async capture(ctx) {
      const ProgressView = await loadBuilt<ComponentType<ProgressViewProps>>(
        distOf(ctx),
        'ProgressView',
        'ProgressView',
      );
      const tracker = new ProgressTracker(40);
      const session = inkSession(<ProgressView tracker={tracker} title="Culling photos" />, {
        cols: 72,
        rows: 3,
      });
      try {
        await session.wait(200);
        tracker.update({ completed: 17, total: 40, label: 'R_J6A3107.CR3' });
        await session.wait(300);
        return screenOf(session.stream(), 72, 3);
      } finally {
        session.stop();
      }
    },
  },
];
