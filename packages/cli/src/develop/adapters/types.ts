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
import type { LabelSet } from '../../triage/labelSets.js';
import type { TriageMarks } from '../../triage/schema.js';
import type { CliIo } from '../../io.js';

/** Progress callback shared by the batch reads (done, total). */
export type ProgressFn = (done: number, total: number) => void;

/**
 * What {@link EditAdapter.writeMarks} actually wrote, for reporting only.
 *
 * Deliberately loose, and deliberately never read back: the keys are whatever
 * names make sense to the photographer looking at `--json` or the summary line —
 * `XMP:Rating` for ACR, `rating` / `tags` for RapidRAW. It was once the *input*
 * to the write, which made exiftool's tag vocabulary a load-bearing part of the
 * interface and left every non-Adobe adapter parsing it back out.
 */
export type AnnotationTags = Record<string, string | number | readonly (string | number)[]>;

/** One image's develop edit, in the canonical (ACR) vocabulary. */
export interface EditRecord {
  /** Absolute canonical develop values actually present (absent ⇒ neutral). */
  develop: Record<string, number>;
  /** Flattened point tone curve [x0,y0,x1,y1,…]; absent when linear. */
  curve?: number[];
  /** Base rendering profile, e.g. "Camera Faithful v2". */
  baseProfile?: string;
  /**
   * Creative profile layered over the base one, e.g. "Adobe Color". Separate
   * from {@link baseProfile} because that is exactly how the editor stores it —
   * Adobe Color is "Adobe Standard v2" plus a Look, not a profile of its own.
   */
  look?: string;
  /** The Look serialized in the editor's own format, for replay on emit. */
  lookXml?: string;
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
  /**
   * The base rendering the predicted values are meant to sit on. Not decoration:
   * an Exposure of +0.35 means what the host's pipeline says it means, and the
   * pipeline starts at the profile. Omitting it leaves the editor to pick its own
   * default, which is how a style learned on Adobe Color lands on Adobe Standard.
   */
  render?: { profile?: string; look?: string; lookXml?: string };
  /**
   * The capture metadata the values were decoded against.
   *
   * The canonical vocabulary states white balance in absolute Kelvin, which only
   * means something next to the temperature the camera recorded. An editor whose
   * own WB control is *relative* to as-shot — RapidRAW's is, in mired — cannot
   * write the prediction without it, and re-reading it from the RAW would be a
   * second exiftool pass over data the caller already holds.
   */
  asShot?: AsShotMeta;
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
   *
   * The map is live, and callers read it only after this call returns — so an
   * adapter whose stored edit is *relative to the capture* may finish filling in
   * the affected {@link EditRecord} entries here. RapidRAW's white balance is
   * exactly that: a shift in mired against the as-shot temperature, which cannot
   * become an absolute Kelvin until the camera has been asked what it shot at,
   * and asking is precisely the expensive pass this method already is.
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

  /**
   * Merge canonical triage marks (`cull` / `rate` decisions) into the sidecar at
   * `sidecarPath`, creating it when it does not exist yet. Returns what was
   * written, for reporting only.
   *
   * Separate from {@link writeEdit} because annotations and develop settings
   * have different owners: a prediction may be templated wholesale, whereas a
   * label or a rating is merged into whatever the sidecar already holds. Keeping
   * them apart is what lets a develop prediction land on a file without erasing
   * the star rating somebody gave it yesterday.
   *
   * The adapter owns the whole write — creation, merge and serialization —
   * rather than returning tags for a shared writer to apply. It has to: the two
   * editors do not even agree on what a sidecar *is*, one being RDF that
   * exiftool merges into and the other a JSON document to be read, amended and
   * rewritten. A shared writer could only ever have been one of the two.
   *
   * `labels` arrives resolved (built-in set plus the user's override) so the
   * adapter never reads configuration itself.
   */
  writeMarks?(marks: TriageMarks, labels: LabelSet, sidecarPath: string): Promise<AnnotationTags>;

  /**
   * Provision whatever this adapter needs before a batch of writes, returning
   * false when it could not be had. Absent ⇒ nothing to provision.
   *
   * Called once before a write loop rather than per file, because that is where
   * a several-megabyte download belongs. Without it every caller had to know
   * that writing happens to go through exiftool — true of ACR, false of an
   * adapter whose sidecar is a JSON file, which would have paid for a tool it
   * never invokes.
   */
  ensureWritable?(io: CliIo): Promise<boolean>;

  /** True when this source can only be read — no emit path exists or is safe. */
  readonly ingestOnly?: boolean;
}
