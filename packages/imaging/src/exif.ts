/**
 * exiftool wrapper. We deliberately shell out to the exiftool binary
 * (Phil Harvey's) rather than reimplementing EXIF/IPTC/XMP parsing — it is
 * the de-facto reference implementation.
 *
 * Requires `exiftool` on PATH, or set SHOOTS_EXIFTOOL to the binary path.
 * Arguments are passed via an stdin argfile (`-@ -`) so huge batches never
 * hit OS command-line length limits (a real concern on Windows).
 */
import { spawn } from 'node:child_process';
import { resolveExiftool } from './tools/exiftool.js';
import { sharedExiftoolDaemon } from './tools/exiftoolDaemon.js';

export class ExiftoolError extends Error {}

export class ExiftoolNotFoundError extends ExiftoolError {
  constructor(message?: string) {
    super(
      message ??
        'exiftool is not available. Run `shoots setup` to download it, or point ' +
          'SHOOTS_EXIFTOOL at an existing exiftool binary.',
    );
  }
}

export interface RunExiftoolOptions {
  /**
   * exiftool exits 1 when *some* files in a batch had errors while others
   * succeeded. With lenient=true we resolve anyway as long as stdout produced
   * output, so one corrupt file cannot fail a whole batch read.
   */
  lenient?: boolean;
}

/**
 * Low-level runner. Returns raw stdout as a Buffer (metadata may be binary).
 *
 * Goes through the shared `-stay_open` daemon when exiftool is provisioned, so
 * the ~190ms Perl startup is paid once per run instead of once per call — see
 * {@link sharedExiftoolDaemon}. Falls back to a one-shot spawn when there is no
 * daemon to use (unprovisioned binary, or SHOOTS_EXIFTOOL_DAEMON=0), which is
 * also the path that reports the missing binary.
 */
export async function runExiftool(args: string[], options: RunExiftoolOptions = {}): Promise<Buffer> {
  const daemon = sharedExiftoolDaemon();
  if (!daemon) return spawnExiftool(args, options);
  let result;
  try {
    result = await daemon.run(args);
  } catch (err) {
    // The binary resolved a moment ago but would not start — deleted, or not
    // executable. Callers distinguish "exiftool is missing" from "this file had
    // no such tag" by the error type, so it has to keep saying which this is.
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') throw new ExiftoolNotFoundError();
    throw err;
  }
  const { stdout, stderr, status } = result;
  if (status === 0) return stdout;
  if (options.lenient && stdout.length > 0) return stdout;
  throw new ExiftoolError(`exiftool exited with code ${status}${stderr ? `: ${stderr}` : ''}`);
}

/** One process per call: the fallback, and what the daemon replaced. */
function spawnExiftool(args: string[], options: RunExiftoolOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const resolved = resolveExiftool();
    if (!resolved) {
      reject(new ExiftoolNotFoundError());
      return;
    }
    const child = spawn(resolved.command, [...resolved.prefixArgs, '-@', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));

    child.on('error', (spawnErr: NodeJS.ErrnoException) => {
      if (spawnErr.code === 'ENOENT') reject(new ExiftoolNotFoundError());
      else reject(spawnErr);
    });

    child.on('close', (code) => {
      const stdout = Buffer.concat(out);
      if (code === 0) {
        resolve(stdout);
      } else if (options.lenient && stdout.length > 0) {
        resolve(stdout);
      } else {
        const stderr = Buffer.concat(err).toString('utf8').trim();
        reject(new ExiftoolError(`exiftool exited with code ${code}${stderr ? `: ${stderr}` : ''}`));
      }
    });

    // One argument per line, per exiftool argfile format.
    child.stdin.write(args.join('\n') + '\n');
    child.stdin.end();
  });
}

/** Returns the exiftool version string, or null when the binary is unavailable. */
export async function exiftoolVersion(): Promise<string | null> {
  try {
    const out = await runExiftool(['-ver']);
    return out.toString('utf8').trim();
  } catch {
    return null;
  }
}

/** One metadata record per file, as produced by `exiftool -json`. */
export interface ExifRecord {
  SourceFile: string;
  [tag: string]: unknown;
}

/** Common args for every invocation: UTF-8 filenames matter on Windows. */
const COMMON_ARGS = ['-charset', 'filename=UTF8'];

export interface ReadMetadataOptions {
  /** Restrict output to these tag names (much faster on big batches). */
  tags?: string[];
  /**
   * Called after each internal batch with the number of files processed so far.
   * A single exiftool run emits its JSON only at the end, so batching is what
   * makes incremental reporting possible at all — see {@link READ_BATCH_SIZE}.
   */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Files per exiftool invocation. Paths reach exiftool through its `-@` argfile on
 * stdin, so there is no command-line length limit to respect; the batching exists
 * to bound the size of the JSON held in memory at once and to give callers a
 * progress signal during the minutes-long reads a network catalog produces.
 * Spawn cost amortizes fine at this size.
 */
const READ_BATCH_SIZE = 500;

/**
 * Batch-read metadata for a set of files. Returns one record per readable file.
 * Files exiftool cannot read are silently absent from the result (lenient mode);
 * callers can diff against their input list if they care.
 */
export async function readMetadata(
  files: readonly string[],
  options: ReadMetadataOptions = {},
): Promise<ExifRecord[]> {
  if (files.length === 0) return [];

  const baseArgs = [...COMMON_ARGS, '-json', '-fast'];
  for (const tag of options.tags ?? []) baseArgs.push(`-${tag}`);

  const records: ExifRecord[] = [];
  for (let i = 0; i < files.length; i += READ_BATCH_SIZE) {
    const batch = files.slice(i, i + READ_BATCH_SIZE);
    const out = await runExiftool([...baseArgs, ...batch], { lenient: true });
    const text = out.toString('utf8').trim();
    if (text) records.push(...(JSON.parse(text) as ExifRecord[]));
    options.onProgress?.(Math.min(i + batch.length, files.length), files.length);
  }
  return records;
}

export interface WriteMetadataOptions {
  /**
   * By default exiftool keeps a `<file>_original` backup next to each modified
   * file — we keep that default on purpose (non-destructive). Set true to
   * modify in place without backups.
   */
  overwriteOriginal?: boolean;
}

/**
 * Batch-write tags to a set of files. Array values append to list-type tags
 * (Keywords, Subject, ...). Returns exiftool's human-readable summary line(s).
 */
export async function writeMetadata(
  files: readonly string[],
  tags: Record<string, string | number | readonly (string | number)[]>,
  options: WriteMetadataOptions = {},
): Promise<string> {
  if (files.length === 0) return 'no files';
  const args = [...COMMON_ARGS];
  if (options.overwriteOriginal) args.push('-overwrite_original');
  for (const [tag, value] of Object.entries(tags)) {
    if (Array.isArray(value)) {
      for (const item of value) args.push(`-${tag}=${item}`);
    } else {
      args.push(`-${tag}=${value as string | number}`);
    }
  }
  args.push(...files);
  const out = await runExiftool(args);
  return out.toString('utf8').trim();
}

/**
 * Write an XMP sidecar (`<file-without-ext>.xmp`) carrying the given tags.
 * Never touches the source image. Fails if the sidecar already exists
 * (exiftool -o refuses to overwrite) — callers should check beforehand.
 */
export async function writeXmpSidecar(
  imageFile: string,
  sidecarPath: string,
  tags: Record<string, string | number | readonly (string | number)[]>,
): Promise<void> {
  const args = [...COMMON_ARGS, '-o', sidecarPath];
  for (const [tag, value] of Object.entries(tags)) {
    if (Array.isArray(value)) {
      for (const item of value) args.push(`-${tag}=${item}`);
    } else {
      args.push(`-${tag}=${value as string | number}`);
    }
  }
  args.push(imageFile);
  await runExiftool(args);
}

/** Preview tags to try, in order of decreasing size/quality. */
const PREVIEW_TAGS = ['JpgFromRaw', 'PreviewImage', 'OtherImage', 'ThumbnailImage'] as const;

/**
 * Extract the embedded JPEG preview from a RAW file (most RAW formats embed
 * a full- or near-full-size JPEG). Returns null when no preview is present.
 */
export async function extractPreview(file: string): Promise<Buffer | null> {
  for (const tag of PREVIEW_TAGS) {
    try {
      const out = await runExiftool([...COMMON_ARGS, '-b', `-${tag}`, file], { lenient: true });
      if (out.length > 0) return out;
    } catch (err) {
      if (err instanceof ExiftoolNotFoundError) throw err;
      // tag missing on this file — try the next one
    }
  }
  return null;
}

/**
 * Read the numeric EXIF orientation (1–8) of a file, or 1 when absent/unknown.
 * A RAW's embedded preview usually drops this tag, so callers that render such a
 * preview need the original's orientation to rotate it upright.
 */
export async function readOrientation(file: string): Promise<number> {
  try {
    // -n = numeric value (1..8), -s3 = bare value with no tag name.
    const out = await runExiftool([...COMMON_ARGS, '-n', '-s3', '-Orientation', file], { lenient: true });
    const n = parseInt(out.toString('utf8').trim(), 10);
    return Number.isInteger(n) && n >= 1 && n <= 8 ? n : 1;
  } catch (err) {
    if (err instanceof ExiftoolNotFoundError) throw err;
    return 1;
  }
}

/** Read a string-valued tag off a record, or null. */
export function getTagString(record: ExifRecord, tag: string): string | null {
  const value = record[tag];
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return null;
}

const EXIF_DATE_RE = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;

/**
 * Parse an EXIF date string ("YYYY:MM:DD HH:MM:SS", optionally with subseconds
 * or a timezone suffix) into a local Date. Timezone offsets are intentionally
 * ignored: for file naming, photographers want the camera's local capture time.
 */
export function parseExifDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = EXIF_DATE_RE.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(
    parseInt(y, 10),
    parseInt(mo, 10) - 1,
    parseInt(d, 10),
    parseInt(h, 10),
    parseInt(mi, 10),
    parseInt(s, 10),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}
