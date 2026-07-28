/**
 * The seam between Shoots and a photo editor.
 *
 * Develop settings are not portable between editors, and no amount of file
 * format work makes them so: XMP is only a container, `crs:` is Adobe's private
 * vocabulary inside it, darktable keeps a base64 module stack in a namespace of
 * its own, Capture One does not use XMP for adjustments at all. Deeper still,
 * the numbers do not transfer even where the names line up — an exposure of
 * +0.35 means what the host's pipeline says it means. A per-editor adapter is
 * therefore not an architectural failure to be avoided; it is the shape of the
 * problem.
 *
 * What the interface buys is that the adapter is the *only* place that knows.
 * The schema, the model, the profile and the evaluation stay in one vocabulary.
 *
 * That vocabulary is ACR's (see `develop/schema.ts`): parameter keys are XMP crs
 * property names. Adobe is the de-facto lingua franca, and the emit path has to
 * speak it anyway, so a non-Adobe adapter translates into these names rather
 * than everyone translating into a neutral third language that no editor reads.
 */
import type { AsShotMeta, Treatment } from '../develop/schema.js';
import type { CliIo } from '../../io.js';

/** Progress callback shared by the batch reads (done, total). */
export type ProgressFn = (done: number, total: number) => void;

/** One image's develop edit, in the canonical (ACR) vocabulary. */
export interface EditRecord {
  /** Absolute canonical develop values actually present (absent ⇒ neutral). */
  develop: Record<string, number>;
  /** Flattened point tone curve [x0,y0,x1,y1,…]; absent when linear. */
  curve?: number[];
  /** Base rendering profile, e.g. "Camera Faithful v2". */
  baseProfile?: string;
  treatment: Treatment;
  /**
   * The file carries a deliberate edit, not merely the neutral defaults the
   * editor writes into everything it touches. Training on the latter teaches
   * the model to predict "change nothing".
   */
  edited: boolean;
  /**
   * Adapter-private, never inspected by callers and never persisted: whatever
   * {@link EditAdapter.readEdits} wants to hand its own {@link
   * EditAdapter.readCapture} so the capture pass need not re-open what the edit
   * pass already read.
   */
  context?: unknown;
}

/** A model prediction ready to be written back out. */
export interface PredictedEdit {
  develop: Record<string, number>;
  treatment: Treatment;
}

export interface EditAdapter {
  /** Stable id used by `--editor`. */
  id: string;
  label: string;

  /**
   * Read the develop edits for a batch of images.
   *
   * A batch rather than one file at a time on purpose: this is one exiftool
   * pass over sidecars today, and it is one query against a catalog database
   * for a source like Lightroom's own `.lrcat` tomorrow. Files with no edit are
   * simply absent from the result.
   *
   * Cheap by contract — callers use it to decide which images deserve the
   * expensive work, so it must not open the image files.
   */
  readEdits(files: string[], io: CliIo, onProgress?: ProgressFn): Promise<Map<string, EditRecord>>;

  /**
   * Read as-shot capture metadata for a batch of images. Opens the image files,
   * so callers run it only over the images they are keeping.
   *
   * `edits` is passed back in because the WB anchor depends on what the edit
   * says about white balance.
   */
  readCapture(
    files: string[],
    edits: Map<string, EditRecord>,
    io: CliIo,
    onProgress?: ProgressFn,
  ): Promise<Map<string, AsShotMeta>>;

  /**
   * Serialize a predicted canonical edit into this editor's own format.
   * Absent on ingest-only sources (a catalog database we must never write to).
   *
   * The treatment travels with the values because it is routing rather than a
   * predicted parameter, and an editor generally needs it stated: a B&W edit
   * whose "convert to grayscale" is missing renders in colour.
   */
  writeEdit?(edit: PredictedEdit, targetPath: string): Promise<void>;

  /** Where {@link writeEdit} should put the sidecar for a given source image. */
  sidecarPathFor?(sourceFile: string, outputDir: string): string;

  /** True when this source can only be read — no emit path exists or is safe. */
  readonly ingestOnly?: boolean;
}
