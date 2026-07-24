/**
 * CLI-side glue for on-demand external tool provisioning.
 *
 * Commands that need exiftool call `ensureExiftoolReady` at their start: it
 * downloads exiftool lazily on first use (with a short progress line on
 * stderr) and returns false — after logging a clear error — when provisioning
 * fails, so the caller can abort cleanly.
 */
import { ensureExiftool } from '@shoots/imaging';
import { logError, markFailure, type CliIo } from './io.js';

export async function ensureExiftoolReady(io: CliIo): Promise<boolean> {
  let lastPct = -1;
  try {
    await ensureExiftool({
      onStatus: (message) => process.stderr.write(`· ${message}...\n`),
      onProgress: (received, total) => {
        if (io.json || !total) return;
        const pct = Math.floor((received / total) * 100);
        if (pct === lastPct) return;
        lastPct = pct;
        process.stderr.write(`\r  ${pct}%${received >= total ? '\n' : ''}`);
      },
    });
    return true;
  } catch (err) {
    logError(err instanceof Error ? err.message : String(err));
    markFailure();
    return false;
  }
}
