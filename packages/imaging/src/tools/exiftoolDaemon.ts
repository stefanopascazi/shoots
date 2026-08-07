/**
 * A long-lived exiftool process, shared by every call in the run.
 *
 * exiftool is a Perl program, and starting it is expensive out of all proportion
 * to the work most calls ask of it: ~190ms of interpreter and module loading on
 * Windows against a handful of milliseconds to read a file's tags. Commands that
 * touch one photograph at a time — extracting an embedded preview, reading an
 * orientation, preserving a sidecar's rating across a develop write — paid that
 * cost per photograph, which on a real shoot is minutes of pure startup.
 *
 * exiftool's own answer is `-stay_open`: one process reads argument batches from
 * a pipe forever, and each batch ends with `-execute<N>`, after which it prints
 * `{ready<N>}` on stdout. We pair that with `-echo4 {ready<N>:${status}}`, which
 * puts the same marker plus the exit status the batch *would* have had on
 * stderr — there are no per-batch exit codes to read otherwise.
 *
 * So a request completes when both markers have arrived:
 *   stdout  <payload bytes>{ready7}\r\n
 *   stderr  <messages>{ready7:0}\r\n
 * The payload is taken verbatim, with no newline trimming: under `-b` exiftool
 * emits raw bytes and no trailing newline before the marker, which is exactly
 * what a one-shot invocation returns too.
 *
 * Requests are serialized. One process handling four calls back to back still
 * beats four processes paying startup in parallel by a wide margin, and the
 * protocol is a single interleaved pipe with no way to tell two concurrent
 * batches apart.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolveExiftool, type ExiftoolCommand } from './exiftool.js';

/** Set SHOOTS_EXIFTOOL_DAEMON=0 to force one-shot spawns (debugging, odd hosts). */
function daemonEnabled(): boolean {
  const v = process.env.SHOOTS_EXIFTOOL_DAEMON;
  return v !== '0' && v !== 'false';
}

export interface DaemonResult {
  stdout: Buffer;
  stderr: string;
  /** The exit status the batch would have had as a one-shot invocation. */
  status: number;
}

interface PendingRequest {
  id: number;
  resolve: (result: DaemonResult) => void;
  reject: (err: Error) => void;
  /** Set once the stdout marker lands; the request completes on the stderr one. */
  stdout?: Buffer;
  stderr?: string;
  status?: number;
}

/**
 * An argument reaches exiftool as one line of an argfile, so a newline inside it
 * would be read as two arguments. A one-shot spawn merely misbehaved; here it
 * would desynchronize the marker stream for every later request, so refuse.
 */
function assertArgfileSafe(args: readonly string[]): void {
  for (const arg of args) {
    if (arg.includes('\n') || arg.includes('\r')) {
      throw new Error(`exiftool argument contains a newline, which the argfile protocol cannot carry: ${JSON.stringify(arg)}`);
    }
  }
}

export class ExiftoolDaemon {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly queue: (() => void)[] = [];
  private current?: PendingRequest;
  /**
   * stdout as it arrives, unjoined. A `-b` preview extraction is megabytes in
   * 64KB pieces, and re-concatenating the whole payload per piece would be
   * quadratic — the copying alone would cost more than the spawn this class
   * exists to avoid. Chunks are joined exactly once, when the marker is found.
   */
  private outChunks: Buffer[] = [];
  private outLen = 0;
  /** Trailing bytes of the last chunk, so a marker split across two is still seen. */
  private outTail: Buffer = Buffer.alloc(0);
  private errBuf = '';
  private exitHook?: () => void;

  constructor(private readonly command: ExiftoolCommand) {}

  /** True when the same resolved binary and prefix args produced this daemon. */
  matches(command: ExiftoolCommand): boolean {
    return (
      command.command === this.command.command &&
      command.prefixArgs.length === this.command.prefixArgs.length &&
      command.prefixArgs.every((a, i) => a === this.command.prefixArgs[i])
    );
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn(this.command.command, [...this.command.prefixArgs, '-stay_open', 'True', '-@', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.clearBuffers();

    child.stdout.on('data', (chunk: Buffer) => this.drainStdout(chunk));
    // latin1 keeps every byte round-trippable; exiftool's messages are ASCII and
    // the markers we scan for certainly are.
    child.stderr.on('data', (chunk: Buffer) => {
      this.errBuf += chunk.toString('latin1');
      this.drainStderr();
    });
    const die = (err: Error): void => this.fail(err);
    child.on('error', die);
    child.on('close', () => die(new Error('exiftool daemon exited unexpectedly')));

    // Deliberately *not* unref'd. An unref'd child stops holding the event loop
    // open, and a caller whose only pending work is this request then never
    // learns the process died — the request hangs instead of failing. The CLI
    // exits explicitly once its output is flushed (see cli.tsx), and the hook
    // below makes sure no exiftool outlives it; anything embedding this calls
    // closeExiftoolDaemon() when it is done.
    this.exitHook = () => {
      try {
        child.kill();
      } catch {
        // already gone
      }
    };
    process.once('exit', this.exitHook);
    return child;
  }

  /** Tear the process down and reject whatever was in flight. */
  private fail(err: Error): void {
    const pending = this.current;
    this.current = undefined;
    const child = this.child;
    this.reset();
    try {
      child?.kill();
    } catch {
      // already gone
    }
    pending?.reject(err);
    // Whatever was queued starts a fresh process rather than inheriting the
    // failure — one at a time, as always.
    this.queue.shift()?.();
  }

  private reset(): void {
    if (this.exitHook) {
      process.removeListener('exit', this.exitHook);
      this.exitHook = undefined;
    }
    this.child = undefined;
    this.clearBuffers();
  }

  private clearBuffers(): void {
    this.outChunks = [];
    this.outLen = 0;
    this.outTail = Buffer.alloc(0);
    this.errBuf = '';
  }

  /**
   * Take one stdout chunk and complete the request if it carries the marker.
   *
   * Only the new chunk is searched, prefixed with the tail of the previous one
   * so a marker straddling the boundary is still found. The payload is the
   * bytes before the marker, verbatim: under `-b` exiftool writes raw data with
   * no trailing newline, so nothing may be trimmed off the end.
   */
  private drainStdout(chunk: Buffer): void {
    const req = this.current;
    if (!req || req.stdout !== undefined) {
      // Nothing is waiting for these bytes (a reply to a request that already
      // failed); dropping them keeps the next request's search clean.
      return;
    }
    const marker = Buffer.from(`{ready${req.id}}`, 'latin1');
    const overlap = this.outTail.length;
    const window = overlap > 0 ? Buffer.concat([this.outTail, chunk]) : chunk;
    const hit = window.indexOf(marker);

    this.outChunks.push(chunk);
    this.outLen += chunk.length;

    if (hit < 0) {
      const keep = Math.min(marker.length - 1, chunk.length);
      this.outTail = chunk.subarray(chunk.length - keep);
      return;
    }

    // Marker offset within the whole stream, undoing the overlap prefix.
    const at = this.outLen - chunk.length - overlap + hit;
    const all = Buffer.concat(this.outChunks, this.outLen);
    req.stdout = all.subarray(0, at);
    // Drop the marker and the line break exiftool prints after it; whatever
    // follows belongs to the next request.
    let rest = at + marker.length;
    if (all[rest] === 0x0d) rest++;
    if (all[rest] === 0x0a) rest++;
    const leftover = all.subarray(rest);
    this.outChunks = leftover.length > 0 ? [leftover] : [];
    this.outLen = leftover.length;
    // The tail must always be the last `outTail.length` bytes of what is held,
    // or the next offset calculation is wrong. Leftover is empty in practice.
    this.outTail = leftover;
    this.settle();
  }

  private drainStderr(): void {
    const req = this.current;
    if (!req || req.stderr !== undefined) return;
    const match = new RegExp(`\\{ready${req.id}:(-?\\d+)\\}\\r?\\n?`).exec(this.errBuf);
    if (!match) return;
    req.stderr = this.errBuf.slice(0, match.index);
    req.status = Number.parseInt(match[1]!, 10);
    this.errBuf = this.errBuf.slice(match.index + match[0].length);
    this.settle();
  }

  /** Resolve once both halves of the request have arrived, then run the next. */
  private settle(): void {
    const req = this.current;
    if (!req || req.stdout === undefined || req.stderr === undefined) return;
    this.current = undefined;
    req.resolve({ stdout: req.stdout, stderr: req.stderr.trim(), status: req.status ?? 0 });
    this.queue.shift()?.();
  }

  /**
   * Run one argument batch. Resolves with its output and the status it produced.
   * `async` so a rejected argument surfaces as a rejection like every other
   * failure, rather than as a synchronous throw callers would have to catch
   * differently.
   */
  async run(args: readonly string[]): Promise<DaemonResult> {
    assertArgfileSafe(args);
    return new Promise<DaemonResult>((resolve, reject) => {
      const dispatch = (): void => {
        const id = this.nextId++;
        this.current = { id, resolve, reject };
        let child: ChildProcessWithoutNullStreams;
        try {
          child = this.start();
        } catch (err) {
          this.current = undefined;
          reject(err instanceof Error ? err : new Error(String(err)));
          this.queue.shift()?.();
          return;
        }
        // -echo4 lands on stderr *after* any message the batch produced, so the
        // marker also tells us the message block is complete.
        const batch = [...args, '-echo4', `{ready${id}:\${status}}`, `-execute${id}`];
        child.stdin.write(batch.join('\n') + '\n');
      };
      // Serialized: dispatch now only when nothing else is mid-flight.
      if (this.current) this.queue.push(dispatch);
      else dispatch();
    });
  }

  /** Stop the process. Idempotent; the next run() starts a fresh one. */
  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.reset();
    child.removeAllListeners('close');
    child.removeAllListeners('error');
    child.on('error', () => {});
    await new Promise<void>((resolve) => {
      child.once('close', () => resolve());
      try {
        child.stdin.write('-stay_open\nFalse\n');
        child.stdin.end();
      } catch {
        child.kill();
      }
      // A wedged process must not hold a command open. Deliberately not
      // unref'd: this timer is the only thing that can resolve the promise if
      // the child never closes, so it has to keep the loop alive to fire.
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 2000);
      child.once('close', () => clearTimeout(timer));
    });
  }
}

let shared: ExiftoolDaemon | undefined;

/**
 * The process-wide daemon, started on first use. Null when exiftool is not
 * provisioned yet or the daemon is disabled — callers fall back to a one-shot
 * spawn, which reports the missing-binary error in the usual way.
 *
 * The resolved binary is re-checked on every call: SHOOTS_EXIFTOOL can point
 * somewhere else between commands (the test suite does exactly this), and a
 * daemon running the previous binary would answer for the wrong one.
 */
export function sharedExiftoolDaemon(): ExiftoolDaemon | null {
  if (!daemonEnabled()) return null;
  const command = resolveExiftool();
  if (!command) return null;
  if (shared && !shared.matches(command)) {
    void shared.close();
    shared = undefined;
  }
  if (!shared) shared = new ExiftoolDaemon(command);
  return shared;
}

/** Shut the shared daemon down (end of a long-running command, or a test). */
export async function closeExiftoolDaemon(): Promise<void> {
  const daemon = shared;
  shared = undefined;
  await daemon?.close();
}
