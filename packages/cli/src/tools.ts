/**
 * CLI-side glue for on-demand external tool provisioning.
 *
 * Commands that need exiftool call `ensureExiftoolReady` at their start: it
 * downloads exiftool lazily on first use (with a short progress line on
 * stderr) and returns false — after logging a clear error — when provisioning
 * fails, so the caller can abort cleanly.
 */
import { ensureExiftool } from '@shoots/imaging';
import { logError, logWarn, markFailure, type CliIo } from './io.js';

function provision(io: CliIo): Promise<unknown> {
  let lastPct = -1;
  return ensureExiftool({
    onStatus: (message) => process.stderr.write(`· ${message}...\n`),
    onProgress: (received, total) => {
      if (io.json || !total) return;
      const pct = Math.floor((received / total) * 100);
      if (pct === lastPct) return;
      lastPct = pct;
      process.stderr.write(`\r  ${pct}%${received >= total ? '\n' : ''}`);
    },
  });
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
