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

const EXIFTOOL_BIN = process.env.SHOOTS_EXIFTOOL ?? 'exiftool';

export class ExiftoolError extends Error {}

export class ExiftoolNotFoundError extends ExiftoolError {
  constructor() {
    super(
      `exiftool binary not found ('${EXIFTOOL_BIN}'). Install it from https://exiftool.org/ ` +
        'and make sure it is on PATH, or point SHOOTS_EXIFTOOL at the binary.',
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

/** Low-level runner. Returns raw stdout as a Buffer (metadata may be binary). */
export function runExiftool(args: string[], options: RunExiftoolOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(EXIFTOOL_BIN, ['-@', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
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
}

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
  const args = [...COMMON_ARGS, '-json', '-fast'];
  for (const tag of options.tags ?? []) args.push(`-${tag}`);
  args.push(...files);
  const out = await runExiftool(args, { lenient: true });
  const text = out.toString('utf8').trim();
  if (!text) return [];
  return JSON.parse(text) as ExifRecord[];
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
