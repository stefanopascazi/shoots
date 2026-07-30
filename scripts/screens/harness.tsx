/**
 * Two ways to get real terminal output out of shoots without a real terminal:
 *
 *   inkSession  — mounts an Ink component against a fake TTY, lets you type into
 *                 it and snapshots the byte stream it paints.
 *   runCommand  — spawns the built CLI with colour forced on and a fixed width.
 *
 * Both hand back the raw ANSI stream; ./ansi.ts turns it into a screen.
 */
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import type { ReactElement } from 'react';
import { render, type Instance } from 'ink';

/** Key sequences as a terminal would send them. */
export const KEY = {
  enter: '\r',
  tab: '\t',
  esc: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  backspace: '\x7f',
} as const;

class FakeStdout extends EventEmitter {
  readonly writes: string[] = [];
  isTTY = true;
  constructor(
    public columns: number,
    public rows: number,
  ) {
    super();
    this.setMaxListeners(0);
  }
  write(data: string): boolean {
    this.writes.push(data);
    return true;
  }
  get stream(): string {
    return this.writes.join('');
  }
}

/**
 * Ink consumes input the way a paused TTY stream delivers it: a `readable`
 * event, then `read()` until it returns null. Anything simpler (emitting
 * `data`) is silently ignored by Ink 6.
 */
class FakeStdin extends EventEmitter {
  isTTY = true;
  private queue: string[] = [];

  constructor() {
    super();
    this.setMaxListeners(0);
  }
  setEncoding(): this {
    return this;
  }
  setRawMode(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  read(): string | null {
    return this.queue.shift() ?? null;
  }
  send(data: string): void {
    this.queue.push(data);
    this.emit('readable');
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export interface InkSession {
  /** Types into the component, one chunk per key, letting React settle. */
  type(...keys: string[]): Promise<void>;
  /** Waits until the painted screen satisfies `predicate`, or times out. */
  waitFor(predicate: (stream: string) => boolean, timeoutMs?: number): Promise<boolean>;
  wait(ms: number): Promise<void>;
  /** Everything painted so far. */
  stream(): string;
  /** Only what was painted since the last `mark()` — use to isolate one frame. */
  mark(): void;
  stop(): void;
  readonly instance: Instance;
}

export interface InkSessionOptions {
  cols: number;
  rows: number;
  /** Grace period for the first paint (env probes, catalog scans). */
  settleMs?: number;
}

export function inkSession(ui: ReactElement, options: InkSessionOptions): InkSession {
  const stdout = new FakeStdout(options.cols, options.rows);
  const stdin = new FakeStdin();
  let markIndex = 0;

  const instance = render(ui, {
    stdout: stdout as never,
    stdin: stdin as never,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  return {
    instance,
    async type(...keys: string[]) {
      for (const key of keys) {
        stdin.send(key);
        await sleep(60);
      }
      await sleep(120);
    },
    async waitFor(predicate, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(stdout.writes.slice(markIndex).join(''))) return true;
        await sleep(150);
      }
      return false;
    },
    wait: sleep,
    stream: () => stdout.writes.slice(markIndex).join(''),
    mark() {
      markIndex = stdout.writes.length;
    },
    stop() {
      instance.unmount();
    },
  };
}

export interface RunCommandOptions {
  cols: number;
  cwd?: string;
  env?: Record<string, string>;
  /** Fail the capture instead of accepting a nonzero exit. */
  expectSuccess?: boolean;
}

export interface CommandResult {
  /** stdout and stderr merged in arrival order, exactly as a TTY would show. */
  stream: string;
  code: number | null;
}

/**
 * The interpreter to run the CLI with. Under Bun (how this script is launched)
 * `process.execPath` is bun itself, and `doctor` would then report Bun's Node
 * compatibility version instead of the machine's Node — so ask for node.
 */
const interpreter = () => ((globalThis as { Bun?: unknown }).Bun ? 'node' : process.execPath);

/** Runs the built CLI (`packages/cli/dist/cli.js`) and captures its output. */
export function runCommand(
  cliPath: string,
  args: string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(interpreter(), [cliPath, ...args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        FORCE_COLOR: '3',
        COLUMNS: String(options.cols),
        ...options.env,
      },
    });

    let stream = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      stream += d;
    });
    child.stderr.on('data', (d: string) => {
      stream += d;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (options.expectSuccess && code !== 0) {
        reject(new Error(`${args.join(' ')} exited ${code}\n${stream}`));
        return;
      }
      resolve({ stream, code });
    });
  });
}

/**
 * Prefixes a captured command output with the prompt line that produced it, so
 * a batch capture reads as a session. The prompt is documentation chrome; every
 * line below it is the command's real output.
 */
export function withPrompt(command: string, output: string): string {
  return `\x1b[38;2;240;180;41m❯\x1b[39m ${command}\n${output}`;
}
