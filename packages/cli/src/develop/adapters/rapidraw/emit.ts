/**
 * Canonical develop edit → a RapidRAW `.rrdata` sidecar.
 *
 * Read, amend, write — not template-and-remerge the way the ACR emitter works.
 * The two differ because the formats do: a `.xmp` has to be templated because
 * its tone curve and Look are nested XML elements no attribute merge handles,
 * and the photographer's rating then has to be carried back over the top. JSON
 * needs none of that theatre. Reading the document, replacing the keys we
 * predict and writing it back preserves masks, crop, lens corrections, LUTs,
 * ratings and tags for free, because we never touched them.
 *
 * That matters more here than it does for ACR: the same `.rrdata` holds the
 * develop settings *and* the triage annotations, so a careless write would be
 * the one that eats yesterday's stars.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mergeAdjustments, toRapidRaw, type RrAdjustments } from './map.js';
import { readSidecar, type RrSidecar } from './ingest.js';

/** The `version` RapidRAW stamps into a sidecar, and the only one it has used. */
const SIDECAR_VERSION = 1;

/**
 * Write `sidecar` back to disk.
 *
 * Pretty-printed, because RapidRAW writes it that way (`to_string_pretty`) and a
 * sidecar that flips between formats on every tool that touches it is noise in
 * whatever the photographer keeps their catalog under.
 */
export async function writeSidecar(sidecarPath: string, sidecar: RrSidecar): Promise<void> {
  await mkdir(path.dirname(sidecarPath), { recursive: true });
  await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2) + '\n', 'utf8');
}

/**
 * Read the sidecar at `sidecarPath`, or the empty document RapidRAW would have
 * written. `rating: 0` and `adjustments: null` are its own defaults.
 */
export async function loadOrCreate(sidecarPath: string): Promise<RrSidecar> {
  const existing = await readSidecar(sidecarPath);
  if (existing) return { version: SIDECAR_VERSION, rating: 0, ...existing };
  return { version: SIDECAR_VERSION, rating: 0, adjustments: null, tags: null };
}

/**
 * Merge a predicted edit into a sidecar document, returning the new one.
 *
 * `asShotKelvin` anchors the white balance — RapidRAW states it relative to the
 * capture, so without it a predicted 5800 K is not a number the file can hold.
 */
export function applyPrediction(
  sidecar: RrSidecar,
  develop: Record<string, number>,
  curve: number[] | undefined,
  asShotKelvin: number | null | undefined,
): RrSidecar {
  const patch = toRapidRaw(develop, curve, asShotKelvin);
  const base: RrAdjustments =
    sidecar.adjustments && typeof sidecar.adjustments === 'object' && !Array.isArray(sidecar.adjustments)
      ? sidecar.adjustments
      : {};
  return { ...sidecar, version: sidecar.version ?? SIDECAR_VERSION, adjustments: mergeAdjustments(base, patch) };
}

/** True when the file already carries a point curve the prediction would replace. */
export function wouldReplaceParametricCurve(sidecar: RrSidecar): boolean {
  const adjustments = sidecar.adjustments;
  if (!adjustments || typeof adjustments !== 'object') return false;
  return (adjustments as RrAdjustments)['curveMode'] === 'parametric';
}
