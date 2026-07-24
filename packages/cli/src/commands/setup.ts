/**
 * shoots setup
 *
 * Provision the external tools shoots relies on (currently exiftool) into
 * `~/.shoots`. Safe to re-run: already-installed, checksum-verified tools are
 * left untouched. Commands also provision lazily on first use, so `setup` is an
 * explicit, up-front alternative (e.g. from an installer or CI image).
 */
import type { Command } from 'commander';
import { ensureExiftool, exiftoolVersion, exiftoolManifest } from '@shoots/imaging';
import { shootsHome } from '@shoots/core';
import { logError, makeIo, printHuman, printJson } from '../io.js';

interface SetupOptions {
  json?: boolean;
  verbose?: boolean;
}

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Download and verify external tools (exiftool) into ~/.shoots')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runSetup);
}

async function runSetup(options: SetupOptions): Promise<void> {
  const io = makeIo(options);
  try {
    const cmd = await ensureExiftool({
      onStatus: (message) => process.stderr.write(`· ${message}...\n`),
      onProgress: (received, total) => {
        if (io.json || !total) return;
        process.stderr.write(`\r  ${Math.floor((received / total) * 100)}%${received >= total ? '\n' : ''}`);
      },
    });
    // Prove the freshly provisioned binary actually runs.
    const version = await exiftoolVersion();
    const manifest = exiftoolManifest();

    if (io.json) {
      printJson({
        command: 'setup',
        home: shootsHome(),
        tools: [{ name: 'exiftool', version: version ?? manifest.version, path: cmd.command, ok: version !== null }],
      });
    } else {
      printHuman(io, `shoots home: ${shootsHome()}`);
      printHuman(io, `exiftool ${version ?? '(unverified)'} ready`);
    }
    if (version === null) {
      logError('exiftool was installed but could not be executed. On macOS/Linux it needs Perl on PATH.');
      process.exitCode = 1;
    }
  } catch (err) {
    logError(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
