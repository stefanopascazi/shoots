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

/**
 * Root for regenerable caches.
 *
 * Everything here is *derived numbers* — a Laplacian measurement, a CLIP
 * embedding, a colour-feature vector — and never pixels. That distinction is
 * the whole reason this directory is safe to leave switched on: the numbers
 * describing a 100k-frame catalog are a few hundred megabytes, while its
 * previews would be hundreds of gigabytes. Deleting any of it costs only the
 * recomputation.
 */
export function cacheDir(): string {
  return path.join(shootsHome(), 'cache');
}

/** The derived-value file for one shoot, named after the folder it came from. */
export function cacheShootPath(folderName: string): string {
  return path.join(cacheDir(), `${folderName}.jsonl`);
}

/** Directory holding user-supplied rating profiles (learned `*.json`). */
export function profilesDir(): string {
  return path.join(shootsHome(), 'profiles');
}

/**
 * Root for the develop predictor's own working files.
 *
 * Namespaced under `develop/` rather than sitting beside {@link profilesDir}:
 * `profiles/` already holds *rating* profiles, and a sibling `profile/` telling
 * a different story one letter apart is a trap for whoever reads it next.
 */
export function developHome(): string {
  return path.join(shootsHome(), 'develop');
}

/** The training dataset `develop init` builds, unless told otherwise. */
export function developExportPath(): string {
  return path.join(developHome(), 'export', 'export.jsonl');
}

/** The style profile `develop init` fits, unless told otherwise. */
export function developProfilePath(): string {
  return path.join(developHome(), 'profile', 'export.json');
}

/**
 * Every (predicted, kept) observation `develop feedback` has ever recorded.
 *
 * Deliberately outside `export/`: everything under there is cache that `develop
 * clean` may drop, and this is the one develop artifact that cannot be rebuilt —
 * it describes photographs as they were the day they were developed.
 */
export function developFeedbackPath(): string {
  return path.join(developHome(), 'feedback.jsonl');
}

/** Root under which each shoot `develop edit` touches keeps its working files. */
export function developShootsDir(): string {
  return path.join(developHome(), 'export', 'shooting');
}

/** Working directory for one shoot, named after the folder it came from. */
export function developShootDir(folderName: string): string {
  return path.join(developShootsDir(), folderName);
}

/**
 * Root for the triage marks `cull` / `rate` leave behind.
 *
 * Deliberately not next to the photographs: a mark is an intermediate fragment,
 * and only the write path (`develop edit` / `triage apply`) is allowed to put
 * anything in the photographer's folder. Everything before that stays here.
 */
export function triageHome(): string {
  return path.join(shootsHome(), 'triage');
}

/** The marks file for one shoot, named after the folder it came from. */
export function triageShootPath(folderName: string): string {
  return path.join(triageHome(), `${folderName}.jsonl`);
}

/** Directory holding user overrides of an editor's label vocabulary. */
export function labelSetsDir(): string {
  return path.join(shootsHome(), 'labels');
}

/**
 * Root for the preference-learning duel databases.
 *
 * One database per profile, named after it: a profile is trained on one genre
 * and one embedding space, and mixing genres in a single DB trains a linear head
 * to be a street eye and a wildlife eye at once — which it cannot be.
 */
export function matchHome(): string {
  return path.join(shootsHome(), 'match');
}

/** The duel database backing a named profile. */
export function matchDbPath(name: string): string {
  return path.join(matchHome(), `${name}.db`);
}

/** Root for log files. */
export function logsDir(): string {
  return path.join(shootsHome(), 'logs');
}

/** Path to the user configuration file. */
export function configPath(): string {
  return path.join(shootsHome(), 'config.json');
}
