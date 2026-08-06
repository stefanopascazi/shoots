/**
 * The RapidRAW adapter — the second {@link EditAdapter}, and the one that proves
 * the seam holds.
 *
 * What it does *not* do is as informative as what it does. RapidRAW has no
 * black-and-white conversion: no grayscale flag, no per-channel mixer, nothing
 * the `bw` branch of the schema could land in. Rather than translate a B&W
 * prediction into `saturation: -100` and throw away the eight parameters that
 * *were* the conversion, the adapter refuses the treatment and says why.
 *
 * The primitives live in `map.ts` (the vocabulary crossing), `ingest.ts`
 * (reading), `emit.ts` (writing) and `marks.ts` (triage); this file is the batch
 * orchestration the develop commands drive.
 */
import path from 'node:path';
import { readMetadata, type ExifRecord } from '@shoots/imaging';
import type { CliIo } from '../../../io.js';
import type { LabelSet } from '../../../triage/labelSets.js';
import type { TriageMarks } from '../../../triage/schema.js';
import { curveFromDevelop, type AsShotMeta } from '../../develop/schema.js';
import type { AnnotationTags, EditAdapter, EditRecord, ProgressFn } from '../types.js';
import { captureHour, META_TAGS, num } from '../exif.js';
import { canonicalCurve, canonicalTemperature, toCanonical, type RrAdjustments } from './map.js';
import { editedAdjustments, readSidecar, sidecarIsEdited, sidecarPathFor } from './ingest.js';
import { applyPrediction, loadOrCreate, writeSidecar } from './emit.js';
import { applyMarks } from './marks.js';

/** The sidecar that belongs to a photograph, in its own folder. */
const besideSource = (file: string): string => sidecarPathFor(file, path.dirname(path.resolve(file)));

/** Index exiftool's output by resolved path so lookups survive path spelling. */
function byResolvedPath(records: ExifRecord[]): Map<string, ExifRecord> {
  const out = new Map<string, ExifRecord>();
  for (const rec of records) out.set(path.resolve(rec.SourceFile), rec);
  return out;
}

async function readEdits(files: string[], _io: CliIo, onProgress?: ProgressFn): Promise<Map<string, EditRecord>> {
  const out = new Map<string, EditRecord>();
  for (const [i, file] of files.entries()) {
    onProgress?.(i + 1, files.length);
    const sidecar = await readSidecar(besideSource(file));
    const adjustments = editedAdjustments(sidecar);
    if (!adjustments) continue;
    const curve = canonicalCurve(adjustments);
    out.set(file, {
      develop: toCanonical(adjustments),
      // RapidRAW has no B&W mode, so every edit it holds is a colour one. Stated
      // rather than derived: `treatmentFromDevelop` reaches the same answer by
      // finding no mixer, which is the right answer for the wrong reason.
      treatment: 'color',
      edited: sidecarIsEdited(sidecar),
      // Handed to readCapture, which finishes the white balance once it knows
      // what the camera shot at — see the note on EditAdapter.readCapture.
      context: adjustments,
      ...(curve ? { curve } : {}),
    });
  }
  return out;
}

async function readCapture(
  files: string[],
  edits: Map<string, EditRecord>,
  _io: CliIo,
  onProgress?: ProgressFn,
): Promise<Map<string, AsShotMeta>> {
  const records = await readMetadata(files, { tags: [...META_TAGS], onProgress });
  const byFile = byResolvedPath(records);
  const out = new Map<string, AsShotMeta>();
  for (const file of files) {
    const exif = byFile.get(path.resolve(file));
    // No editor-dependent disambiguation to do here, unlike ACR: RapidRAW never
    // records a chosen Kelvin that could be mistaken for the camera's own.
    const tempAsShot = num(exif?.['ColorTempAsShot']) ?? num(exif?.['ColorTemperature']);
    out.set(file, {
      tempAsShot,
      tempMeasured: num(exif?.['ColorTempMeasured']),
      tintAsShot: null, // no edit-independent Kelvin tint source; the delta falls back to 0
      iso: num(exif?.['ISO']),
      exposureComp: num(exif?.['ExposureCompensation']),
      camera: typeof exif?.['Model'] === 'string' ? (exif['Model'] as string) : null,
      hour: captureHour(exif?.['DateTimeOriginal'] ?? exif?.['CreateDate']),
    });

    // Only now can the white balance target be stated at all.
    const edit = edits.get(file);
    const adjustments = edit?.context as RrAdjustments | undefined;
    if (!edit || !adjustments) continue;
    const kelvin = canonicalTemperature(adjustments, tempAsShot);
    if (kelvin !== null) edit.develop['Temperature'] = kelvin;
  }
  return out;
}

export const rapidrawAdapter: EditAdapter = {
  id: 'rapidraw',
  label: 'RapidRAW (.rrdata JSON sidecars)',
  readEdits,
  readCapture,
  async writeEdit(edit, targetPath) {
    if (edit.treatment === 'bw') {
      throw new Error(
        'RapidRAW has no black-and-white conversion (no grayscale mode, no channel mixer), so a `bw` ' +
          'prediction cannot be written for it — use `--treatment color`, or `--editor acr` for B&W.',
      );
    }
    const sidecar = await loadOrCreate(targetPath);
    // The curve travels as per-knot parameters inside `develop`; rebuilding it is
    // the emitter's job here exactly as it is in the ACR one.
    const next = applyPrediction(sidecar, edit.develop, curveFromDevelop(edit.develop), edit.asShot?.tempAsShot);
    await writeSidecar(targetPath, next);
  },
  sidecarPathFor,
  async writeMarks(marks: TriageMarks, labels: LabelSet, sidecarPath: string): Promise<AnnotationTags> {
    const sidecar = await loadOrCreate(sidecarPath);
    const { sidecar: next, written } = applyMarks(sidecar, marks, labels);
    if (Object.keys(written).length === 0) return written;
    await writeSidecar(sidecarPath, next);
    return written;
  },
  // No `ensureWritable`: both sides of this adapter are plain JSON files.
  // exiftool is still needed for the *capture* read, and `develop export` asks
  // for it there on its own account.
};
