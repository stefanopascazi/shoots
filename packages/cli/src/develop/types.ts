/**
 * Shared types for the develop tool.
 *
 * It never touches CLIP/onnx: it consumes the dataset emitted by
 * `shoots develop-export` (CLIP embedding + explicit color features + crs develop
 * targets + as-shot metadata + treatment/profile), fits ONE ridge model per
 * treatment (colour / B&W) over that treatment's shared+branch parameters, and
 * exports a branched per-catalog develop profile.
 */
import type { AsShotMeta, Treatment } from './develop/schema.js';

/** One image record inside a `shoots develop-export` dataset. */
export interface DevelopExportResult {
  file: string;
  embedding: number[];
  features: number[];
  /** Raw absolute crs develop values actually present (absent ⇒ ACR default). */
  develop: Record<string, number>;
  asShot: AsShotMeta;
  /** Black-and-white vs colour, read deterministically off the edit. */
  treatment?: Treatment;
  /**
   * The file carries a deliberate edit, not merely the neutral defaults the
   * editor writes into everything it touches.
   *
   * Recorded per file rather than filtered at export time, because the two uses
   * of a record pull in opposite directions: only a real edit is a valid
   * *training target*, but every frame — edited or not — describes its
   * *session*. Absent on datasets exported before this existed, where
   * `--edited-only` was the only filter available.
   */
  edited?: boolean;
  /** Base rendering profile (crs CameraProfile), e.g. "Camera Faithful v2". */
  baseProfile?: string;
  /** Creative profile layered over it (crs Look name), e.g. "Adobe Color". */
  look?: string;
  /** Flattened point tone-curve [x0,y0,x1,y1,…] (ToneCurvePV2012); absent if linear. */
  curve?: number[];
  /** Present only in the legacy per-record format; the baseline lives on the dataset. */
  baseline?: string;
  /**
   * How much this photograph counts in the fit. Absent ⇒ 1.
   *
   * Set by `develop learn`, which folds a shoot you have already developed back
   * into the training set weighted by how much of the prediction you had to
   * change. A frame you overhauled teaches more about where the model is wrong
   * than a frame you accepted — and a frame you accepted is partly the model's
   * own output coming back, which is precisely what should count for least.
   */
  weight?: number;
}

/** The whole `shoots develop-export` payload. */
export interface DevelopDataset {
  command: 'develop-export';
  model: string;
  dim: number;
  colorFeatureNames: string[];
  colorDim: number;
  baseline: string;
  /**
   * Look name → the editor's own serialization of it, once per distinct Look
   * rather than once per photograph. A Look is a catalog-level object and its
   * element runs to a couple of kilobytes; copying it onto every record would
   * put tens of megabytes of identical text into a 20k-image dataset.
   */
  looks?: Record<string, string>;
  /**
   * The shoots version that *extracted the features* — read by `release-notes`.
   * Deliberately not refreshed by `develop refresh-targets`: that command
   * rewrites the targets and leaves the feature vectors exactly as exported, so
   * re-stamping it would hide a migration that is still outstanding.
   */
  toolVersion?: string;
  results: DevelopExportResult[];
  summary?: unknown;
}

/** Held-out evidence for one head's contribution to one parameter. */
export interface HeadEval {
  /** Ridge strength chosen for this parameter on this head. */
  lambda: number;
  /** Held-out skill of the raw ridge output — what the gate is decided on. */
  skill: number;
  skillSd: number;
  /**
   * The same skill for the head as it actually ships: gate applied, output
   * de-shrunk. Usually a little *below* {@link skill}, and that is the trade
   * being made on purpose — the shrunk output is the MAE-optimal one, so buying
   * back the reach costs error. A prediction that never leaves the average has no
   * error to speak of and no use either.
   */
  shippedSkill: number;
  /** De-shrinking slope actually applied at prediction time. */
  response: number;
  gated: boolean;
  gateReason?: 'low-skill' | 'degenerate';
}

/** Per-parameter held-out evaluation — the go/no-go evidence. */
export interface ParamEval {
  key: string;
  group: string;
  branch: string;
  weight: number;
  /**
   * The level head: where this parameter sits for the shoot as a whole, read off
   * the session descriptor. Gated ⇒ the photographer's catalog-wide constant.
   */
  level: HeadEval;
  /**
   * The frame head: how far this photograph departs from its shoot's own level,
   * read off the frame's deviation vector. Gated ⇒ no per-frame modulation, which
   * is the honest way to say "every frame in this shoot gets the same value".
   *
   * This is the number to read when a prediction feels like a default. Its
   * baseline is the shoot's true level, so a positive skill here means the model
   * really does tell a backlit frame from one in open shade.
   */
  frame: HeadEval;
  /** Ridge strength of the level head — kept flat for the report's λ spread. */
  lambda: number;
  /** Held-out MAE with whole capture sessions kept out of training — the gate. */
  modelMae: number;
  /** Same policy, for "apply my average edit" (the mean target delta). */
  baselineMae: number;
  skill: number;
  /**
   * Spread of {@link skill} across the held-out folds — its error bar.
   *
   * A single per-parameter figure invites conclusions it cannot support. On the
   * reference catalog `Shadows2012` swung between −5% and +14% across repeated
   * fold assignments with no change to the model, which read as a regression the
   * one time it landed low. Compare parameters, and versions, against this.
   */
  skillSd: number;
  /**
   * Skill with folds drawn at random instead of by session. Near-duplicate
   * frames from one shoot then sit on both sides of the split, so this measures
   * "finish a shoot already under way" — a real scenario, but not the one the
   * gate asks about. The gap against {@link skill} is the leakage meter.
   */
  skillRandom: number;
  /** The target never moves across the catalog: nothing to predict, and a
   *  perfect score on it would be an artefact. Excluded from the headline. */
  degenerate: boolean;
  /** Both heads gated: the parameter emits the photographer's constant, full stop. */
  gated: boolean;
  gateReason?: 'low-skill' | 'degenerate';
}

/**
 * One linear head over one view of the evidence.
 *
 * A branch has two of them and adds their outputs: the *level* head reads the
 * session descriptor and says where the shoot sits, the *frame* head reads this
 * photograph's deviation from its shoot and says how far it departs. Fitted
 * separately, gated separately, de-shrunk separately — which is the whole point.
 * Entangled in one regression the level view always won, because a shoot average
 * is a near-noiseless predictor of that shoot's own offset, and the per-frame
 * columns were left with a tenth of their honest coefficients.
 */
export interface HeadModel {
  /** Input width this head consumes; inference must assemble exactly this many. */
  features: number;
  /** Embedding columns kept: 0 dropped, the PCA rank when projected, else raw. */
  embeddingFeatures: number;
  /** The fitted projection, present only when the embedding is compressed. */
  embeddingPca?: { mean: number[]; components: number[][] };
  /** Per-feature standardization of this head's input. */
  featureMean: number[];
  featureStd: number[];
  /** Per-parameter standardization of this head's target, index-aligned with `params`. */
  targetMean: number[];
  targetStd: number[];
  /** Head weights: P rows × `features` cols, over the standardized input. */
  weights: number[][];
  bias: number[];
  /** Ridge strength per parameter (per-sample units — see LAMBDA_GRID). */
  paramLambda: number[];
  /**
   * De-shrinking factor per parameter, applied to this head's centered output.
   *
   * Ridge hands back an under-dispersed conditional mean; this is the held-out
   * slope that puts the reach back. 1 leaves the output alone. See
   * {@link ParamStats.response}.
   */
  response: number[];
  /** Per-parameter: this head contributes nothing (its constant, or zero). */
  gated: boolean[];
}

/** A trained model for one treatment (colour or B&W), over shared+branch params. */
export interface BranchModel {
  treatment: Treatment;
  /** Ordered crs param keys this branch predicts (shared + branch). */
  params: string[];
  /** Base-rendering vocabulary (camera profile + Look) one-hot-appended to the level head. */
  renderVocab: string[];
  /** Where the shoot sits, from the session descriptor. */
  level: HeadModel;
  /** How far this frame departs from its shoot, from its deviation vector. */
  frame: HeadModel;
  /**
   * The rendering to assume, and to write out, when the image being predicted
   * does not state one — which is every unedited file, i.e. the whole point of
   * the tool. It is the branch's most common rendering, because that is the one
   * most of the learned deltas were measured against.
   */
  defaultRender: { profile?: string; look?: string };
  /**
   * Look name → the editor's own serialization, for every Look this branch can
   * emit. Carried in the profile because a Look cannot be reconstructed from its
   * name: it is resolved by UUID and look-table digest, and inventing a
   * plausible-looking element is a guess that fails inside someone's catalog.
   */
  looks: Record<string, string>;
  /**
   * The photographer's catalog-wide mean delta per parameter — what a fully gated
   * parameter emits, and the fallback the level head is scored against.
   */
  deltaMean: number[];
  deltaStd: number[];
  samples: number;
  /** Distinct capture sessions behind the fit — the level head's real sample size. */
  sessions: number;
  heldOut: number;
  /** Weighted end-to-end skill over the image-dependent params, sessions held out. */
  imageDependentSkill: number | null;
  /** The same number under random folds — reported for contrast, never the gate. */
  imageDependentSkillRandom: number | null;
  /**
   * Weighted skill of the frame head alone, against the shoot's own true level.
   *
   * The number that says whether this profile is a prediction or a default. It is
   * deliberately separate from {@link imageDependentSkill}, which a model that
   * only ever reproduces per-shoot averages can score well on.
   */
  withinSessionSkill: number | null;
  /** Params emitting the photographer's constant — both heads gated. */
  gatedParams: string[];
  /** Params with no per-frame modulation: the frame head is gated. */
  flatParams: string[];
  /** Skill at or below which the level head is gated (0 disables gating). */
  gateThreshold: number;
  /** Skill at or below which the frame head is gated. */
  frameGateThreshold: number;
  perParam: ParamEval[];
}

/**
 * The deliverable: one {@link BranchModel} per treatment present in the catalog,
 * plus the guards (schema version + dims + embedding model) that gate
 * applicability, exactly like the linear-embedding rating profile.
 */
/**
 * What the photographer's own corrections say this profile is wrong by.
 *
 * Kept beside the model rather than folded into its weights, on purpose: it is
 * measured on different evidence (real corrections, not held-out catalog edits),
 * it is reversible in one command, and a reader can see exactly how much of a
 * prediction is model and how much is correction. Folding it in would make all
 * three impossible.
 */
export interface DevelopCalibration {
  at: string;
  /** The profile this was measured against — a retrain invalidates it. */
  profileTrainedAt: string;
  /** Observations behind it, per branch. */
  images: Partial<Record<Treatment, number>>;
  /** Shoots behind it — the unit the direction test actually counts in. */
  shoots?: Partial<Record<Treatment, number>>;
  /** Fraction of the measured correction actually applied. */
  shrink: number;
  /** Absolute offsets per branch, in each parameter's correction space. */
  offsets: Partial<Record<Treatment, Record<string, number>>>;
}

export interface DevelopProfile {
  name: string;
  description: string;
  type: 'develop-branched';
  schemaVersion: number;
  embeddingModel: string;
  embeddingDim: number;
  colorDim: number;
  colorFeatureNames: string[];
  baseline: string;
  branches: Partial<Record<Treatment, BranchModel>>;
  trainedAt: string;
  /**
   * The shoots version that fitted this profile — what `release-notes` compares
   * against to decide whether a migration step is outstanding. Absent on
   * profiles written by 0.4.8 or earlier, which is itself the answer.
   */
  toolVersion?: string;
  stats: {
    edited: number;
    color: number;
    bw: number;
    /** Records that fed the session description — edited or not. */
    described?: number;
  };
  /** Set by `develop calibrate`; absent until the journal has something to say. */
  calibration?: DevelopCalibration;
}
