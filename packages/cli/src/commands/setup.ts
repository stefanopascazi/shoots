/**
 * shoots setup
 *
 * Provision the external dependencies shoots relies on into `~/.shoots`: the
 * exiftool binary, the LibRaw `dcraw_emu` RAW developer (neutral develop
 * baseline) and the ONNX CLIP inference model. Safe to re-run: already-
 * installed, checksum-verified dependencies are left untouched. Commands also
 * provision lazily on first use, so `setup` is an explicit, up-front alternative
 * (e.g. from an installer or CI image).
 */
import type { Command } from 'commander';
import {
  ensureExiftool,
  exiftoolVersion,
  exiftoolManifest,
  ensureLibraw,
  librawManifest,
  LibrawMirrorNotConfiguredError,
} from '@shoots/imaging';
import { ensureClipModel, ModelMirrorNotConfiguredError } from '@shoots/inference';
import { shootsHome } from '@shoots/core';
import { logError, logWarn, makeIo, printHuman, printJson } from '../io.js';
import { mirrorProgress } from '../tools.js';

interface SetupOptions {
  json?: boolean;
  verbose?: boolean;
}

interface DependencyReport {
  name: string;
  version: string | null;
  path: string | null;
  ok: boolean;
  detail?: string;
}

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Download and verify external tools (exiftool, libraw) and the inference model into ~/.shoots')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runSetup);
}

async function provisionExiftool(options: SetupOptions, io: ReturnType<typeof makeIo>): Promise<DependencyReport> {
  try {
    const cmd = await ensureExiftool(mirrorProgress(io));
    const version = await exiftoolVersion();
    const manifest = exiftoolManifest();
    if (version === null) {
      logError('exiftool was installed but could not be executed. On macOS/Linux it needs Perl on PATH.');
      process.exitCode = 1;
    }
    return { name: 'exiftool', version: version ?? manifest.version, path: cmd.command, ok: version !== null };
  } catch (err) {
    logError(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return { name: 'exiftool', version: null, path: null, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function provisionLibraw(io: ReturnType<typeof makeIo>): Promise<DependencyReport> {
  try {
    const bin = await ensureLibraw(mirrorProgress(io));
    return { name: 'libraw', version: librawManifest().version, path: bin, ok: true };
  } catch (err) {
    // A libraw mirror that is not yet configured is a non-fatal, expected state
    // during development — warn rather than failing the whole setup.
    if (err instanceof LibrawMirrorNotConfiguredError) {
      logWarn(err.message);
      return { name: 'libraw', version: null, path: null, ok: false, detail: 'mirror not configured' };
    }
    logError(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return { name: 'libraw', version: null, path: null, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function provisionModel(io: ReturnType<typeof makeIo>): Promise<DependencyReport> {
  try {
    const m = await ensureClipModel(mirrorProgress(io));
    return { name: 'inference model', version: m.version, path: m.installDir, ok: true };
  } catch (err) {
    // A model mirror that is not yet configured is a non-fatal, expected state
    // during development — warn rather than failing the whole setup.
    if (err instanceof ModelMirrorNotConfiguredError) {
      logWarn(err.message);
      return { name: 'inference model', version: null, path: null, ok: false, detail: 'mirror not configured' };
    }
    logError(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return { name: 'inference model', version: null, path: null, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function runSetup(options: SetupOptions): Promise<void> {
  const io = makeIo(options);

  const deps: DependencyReport[] = [];
  deps.push(await provisionExiftool(options, io));
  deps.push(await provisionLibraw(io));
  deps.push(await provisionModel(io));

  if (io.json) {
    printJson({ command: 'setup', home: shootsHome(), tools: deps });
  } else {
    printHuman(io, `shoots home: ${shootsHome()}`);
    for (const d of deps) {
      const state = d.ok ? `${d.version ?? ''} ready`.trim() : d.detail ?? 'not available';
      printHuman(io, `${d.name}: ${state}`);
    }
  }
}
