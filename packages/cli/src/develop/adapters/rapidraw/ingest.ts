/**
 * RapidRAW → the canonical develop edit.
 *
 * Everything that knows where RapidRAW keeps an edit and what shape it is in
 * lives here; the vocabulary crossing itself is `map.ts`.
 *
 * A `.rrdata` is a plain JSON document beside the photograph, not a catalog, so
 * reading one costs a file read and no exiftool at all. What it does *not* carry
 * is the camera's as-shot temperature — its own white balance is a shift
 * relative to that — so the WB target is completed in the capture pass, where
 * the RAW is being opened anyway.
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { isEdited, type RrAdjustments } from './map.js';

/** The `.rrdata` document, as far as this tool is concerned. */
export interface RrSidecar {
  version?: number;
  /** Stars, 0–5. RapidRAW's own field — the same one `triage rate` writes. */
  rating?: number;
  /** Null on every file the photographer has never adjusted. */
  adjustments?: RrAdjustments | null;
  /** Free tags, namespaced by RapidRAW: `color:red`, `user:portrait`. */
  tags?: string[] | null;
  exif?: Record<string, string> | null;
}

/**
 * Where RapidRAW keeps a photograph's edit.
 *
 * The whole filename plus `.rrdata`, extension included — `R-FD-28-5230.CR3`
 * becomes `R-FD-28-5230.CR3.rrdata`, not `R-FD-28-5230.rrdata`. That is what
 * lets a folder hold both a CR3 and a JPEG of the same frame without the two
 * edits colliding, and it is the opposite of the ACR convention.
 */
export function sidecarPathFor(sourceFile: string, outputDir: string): string {
  return path.join(outputDir, `${path.basename(sourceFile)}.rrdata`);
}

/**
 * Read and parse one sidecar. Returns null when there is none, or when the file
 * is not usable JSON.
 *
 * Lenient on the parse for the same reason the mark store is: a half-written
 * sidecar after a crash is one photograph's problem, and taking the whole shoot
 * down over it helps nobody.
 */
export async function readSidecar(sidecarPath: string): Promise<RrSidecar | null> {
  let text: string;
  try {
    text = await readFile(sidecarPath, 'utf8');
  } catch {
    return null;
  }
  try {
    // Hand-copied sidecars and Windows text tools both produce a BOM, which
    // JSON.parse rejects outright.
    const parsed: unknown = JSON.parse(text.replace(/^﻿/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as RrSidecar;
  } catch {
    return null;
  }
}

/**
 * The adjustments of a sidecar, or null when the photograph carries no edit.
 *
 * `adjustments: null` is RapidRAW's own way of saying "never touched", and it is
 * the ordinary state of an imported folder — thirty of thirty-one files in the
 * reference shoot. The second test catches the other shape: a full object that
 * the app wrote on save while every slider still sat at its default.
 */
export function editedAdjustments(sidecar: RrSidecar | null): RrAdjustments | null {
  const adjustments = sidecar?.adjustments;
  if (!adjustments || typeof adjustments !== 'object' || Array.isArray(adjustments)) return null;
  return adjustments;
}

/** True when the sidecar records a deliberate edit rather than saved defaults. */
export function sidecarIsEdited(sidecar: RrSidecar | null): boolean {
  return isEdited(editedAdjustments(sidecar));
}
