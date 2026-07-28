/**
 * CLI-side glue for on-demand provisioning of external tools and ML models.
 *
 * Commands call these `ensure*Ready` helpers at their start: they download the
 * dependency lazily on first use (with a short progress line on stderr) and
 * return false — after logging a clear error — when provisioning fails, so the
 * caller can abort cleanly. The same download UX is used by `shoots setup`.
 */
import { ensureExiftool, ensureLibraw, LibrawMirrorNotConfiguredError } from '@shoots/imaging';
import { ensureClipModel, ModelMirrorNotConfiguredError } from '@shoots/inference';
import { logError, logWarn, markFailure, type CliIo } from './io.js';

/**
 * Shared download reporter: a status line plus a throttled percentage on stderr,
 * suppressed under --json. Reused by every provisioning path so the download UX
 * is identical across tools and models (and in `setup`).
 */
export function mirrorProgress(io: CliIo): { onStatus: (m: string) => void; onProgress: (received: number, total: number | null) => void } {
  let lastPct = -1;
  return {
    onStatus: (message) => process.stderr.write(`· ${message}...\n`),
    onProgress: (received, total) => {
      if (io.json || !total) return;
      const pct = Math.floor((received / total) * 100);
      if (pct === lastPct) return;
      lastPct = pct;
      process.stderr.write(`\r  ${pct}%${received >= total ? '\n' : ''}`);
    },
  };
}

function provision(io: CliIo): Promise<unknown> {
  return ensureExiftool(mirrorProgress(io));
}

/**
 * Hard requirement: provision exiftool, and on failure log an error, mark the
 * run as failed and return false so the caller aborts. For commands that cannot
 * work at all without exiftool (rename, exif, cull on RAW, rate --write-xmp).
 */
export async function ensureExiftoolReady(io: CliIo): Promise<boolean> {
  try {
    await provision(io);
    return true;
  } catch (err) {
    logError(err instanceof Error ? err.message : String(err));
    markFailure();
    return false;
  }
}

/**
 * Best-effort: provision exiftool, but on failure only warn and continue — the
 * caller has a usable fallback (e.g. import can date folders by file mtime).
 * Returns whether exiftool ended up available.
 */
export async function tryEnsureExiftool(io: CliIo): Promise<boolean> {
  try {
    await provision(io);
    return true;
  } catch (err) {
    logWarn(
      `exiftool unavailable (${err instanceof Error ? err.message : String(err)}). ` +
        'Falling back to file modification times.',
    );
    return false;
  }
}

/**
 * Hard requirement: provision LibRaw (`dcraw_emu`) for the neutral RAW baseline
 * (`develop export --baseline external`). On failure log a clear error, mark the
 * run failed and return false so the caller aborts. When the libraw mirror is not
 * pinned yet, the error points at the `SHOOTS_RAW_DEVELOPER` escape hatch.
 */
export async function ensureLibrawReady(io: CliIo): Promise<boolean> {
  try {
    await ensureLibraw(mirrorProgress(io));
    return true;
  } catch (err) {
    if (err instanceof LibrawMirrorNotConfiguredError) {
      logError(
        `the neutral RAW baseline needs LibRaw, but its mirror is not configured yet (${err.message}). ` +
          'Meanwhile point SHOOTS_RAW_DEVELOPER at a local dcraw_emu / rawtherapee-cli.',
      );
    } else {
      logError(err instanceof Error ? err.message : String(err));
    }
    markFailure();
    return false;
  }
}

/**
 * Hard requirement: provision the ONNX CLIP model (downloaded and checksum-
 * verified into ~/.shoots/models on first use). On failure log an error, mark
 * the run failed and return false so the caller aborts. Used by `rate` and
 * shared with `setup`.
 */
export async function ensureClipModelReady(io: CliIo): Promise<boolean> {
  try {
    await ensureClipModel(mirrorProgress(io));
    return true;
  } catch (err) {
    if (err instanceof ModelMirrorNotConfiguredError) {
      logError(`inference model not available: ${err.message}`);
    } else {
      logError(err instanceof Error ? err.message : String(err));
    }
    markFailure();
    return false;
  }
}
