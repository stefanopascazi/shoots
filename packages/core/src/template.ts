/**
 * Filename templating shared by `shoots import` and `shoots rename`.
 *
 * Supported tokens:
 *   {date}    capture date as YYYYMMDD (falls back to "nodate")
 *   {time}    capture time as HHMMSS   (falls back to "notime")
 *   {year} {month} {day}
 *   {camera}  camera model from EXIF, sanitized (falls back to "unknown-camera")
 *   {lens}    lens model from EXIF, sanitized   (falls back to "unknown-lens")
 *   {orig}    original file name without extension
 *   {seq}     1-based sequence number; supports zero-padding via {seq:4} → 0001
 *   {ext}     lowercase file extension without dot
 */

export interface TemplateContext {
  date?: Date | null;
  camera?: string | null;
  lens?: string | null;
  /** Lowercase extension without the leading dot. */
  ext: string;
  /** Original file name without extension. */
  originalName: string;
  /** 1-based sequence number within the batch. */
  seq?: number;
}

export class TemplateError extends Error {}

const TOKEN_RE = /\{([a-zA-Z]+)(?::(\d+))?\}/g;

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** Make a metadata value safe for use inside a file name. */
export function sanitizeToken(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function renderTemplate(pattern: string, ctx: TemplateContext): string {
  return pattern.replace(TOKEN_RE, (_match, token: string, padWidth?: string) => {
    const d = ctx.date ?? null;
    switch (token) {
      case 'date':
        return d ? `${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}` : 'nodate';
      case 'time':
        return d ? `${pad(d.getHours(), 2)}${pad(d.getMinutes(), 2)}${pad(d.getSeconds(), 2)}` : 'notime';
      case 'year':
        return d ? String(d.getFullYear()) : 'noyear';
      case 'month':
        return d ? pad(d.getMonth() + 1, 2) : 'nomonth';
      case 'day':
        return d ? pad(d.getDate(), 2) : 'noday';
      case 'camera':
        return ctx.camera ? sanitizeToken(ctx.camera) : 'unknown-camera';
      case 'lens':
        return ctx.lens ? sanitizeToken(ctx.lens) : 'unknown-lens';
      case 'orig':
        return sanitizeToken(ctx.originalName);
      case 'seq':
        return pad(ctx.seq ?? 0, padWidth ? parseInt(padWidth, 10) : 1);
      case 'ext':
        return ctx.ext;
      default:
        throw new TemplateError(`Unknown template token {${token}}`);
    }
  });
}

/** Tokens whose values come from capture metadata (EXIF), needing exiftool. */
const CAPTURE_TOKENS: ReadonlySet<string> = new Set([
  'date',
  'time',
  'year',
  'month',
  'day',
  'camera',
  'lens',
]);

/**
 * True when the template references any capture-metadata token, i.e. rendering
 * it accurately requires reading EXIF. Date-derived tokens fall back to file
 * mtime when EXIF is unavailable, but they still signal "read EXIF if you can".
 */
export function templateNeedsCaptureMetadata(pattern: string): boolean {
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(pattern)) !== null) {
    if (CAPTURE_TOKENS.has(match[1])) return true;
  }
  return false;
}

/**
 * Validate a template pattern against a dummy context.
 * Returns null when valid, otherwise a human-readable error message.
 */
export function validateTemplate(pattern: string): string | null {
  try {
    const rendered = renderTemplate(pattern, {
      date: new Date(2026, 0, 1, 12, 0, 0),
      camera: 'Test Camera',
      lens: 'Test Lens',
      ext: 'jpg',
      originalName: 'IMG_0001',
      seq: 1,
    });
    if (rendered.length === 0) return 'Template renders to an empty name';
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
