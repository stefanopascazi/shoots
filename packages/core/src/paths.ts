/**
 * Resolves the shoots user-data directory and its well-known subfolders.
 *
 * A single home under the user's profile (`~/.shoots`, uniform across OSes)
 * holds everything that is machine-local and provisioned at runtime: external
 * tools (exiftool), ML models, caches, config and logs. Using a fixed,
 * deterministic location means no environment variables need to be set on
 * end-user machines. Override the base with SHOOTS_HOME (tests / portable use).
 */
import os from 'node:os';
import path from 'node:path';

const HOME_ENV = 'SHOOTS_HOME';

/** Absolute path to the shoots home directory (`~/.shoots` by default). */
export function shootsHome(): string {
  const override = process.env[HOME_ENV];
  if (override && override.length > 0) return path.resolve(override);
  return path.join(os.homedir(), '.shoots');
}

/** Root for downloaded external tools, e.g. exiftool. */
export function binDir(): string {
  return path.join(shootsHome(), 'bin');
}

/** Install directory for a specific version of a named tool. */
export function toolDir(name: string, version: string): string {
  return path.join(binDir(), name, version);
}

/** Root for downloaded ML models (e.g. ONNX quality models). */
export function modelsDir(): string {
  return path.join(shootsHome(), 'models');
}

/** Install directory for a specific version of a named model. */
export function modelDir(name: string, version: string): string {
  return path.join(modelsDir(), name, version);
}

/** Root for regenerable caches (thumbnails, RAW previews). */
export function cacheDir(): string {
  return path.join(shootsHome(), 'cache');
}

/** Directory holding user-supplied rating profiles (learned `*.json`). */
export function profilesDir(): string {
  return path.join(shootsHome(), 'profiles');
}

/** Root for log files. */
export function logsDir(): string {
  return path.join(shootsHome(), 'logs');
}

/** Path to the user configuration file. */
export function configPath(): string {
  return path.join(shootsHome(), 'config.json');
}
