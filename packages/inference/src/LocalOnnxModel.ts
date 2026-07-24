/**
 * ONNX-backed QualityModel (the real backend behind `--model onnx`).
 *
 * Scope today: this wires provisioning and runtime end to end — it downloads the
 * CLIP model on first use (into ~/.shoots/models, checksum-verified) and opens
 * the ONNX image encoder via onnxruntime-node. The scoring itself is not wired
 * yet: the aesthetic head and the zero-shot keyword vocabulary depend on choices
 * still open (a commercially-clean aesthetic approach — training data, not just
 * code license). Until then, scoring throws a clear error rather than returning
 * fabricated numbers.
 *
 * In production `--model onnx` fails cleanly at init() with
 * ModelMirrorNotConfiguredError until the model mirror is built and pinned.
 */
// Type-only import: erased at compile time, so it never loads the native addon.
import type { InferenceSession } from 'onnxruntime-node';
import type { ImageInput, QualityAssessment, QualityModel } from './QualityModel.js';
import {
  CLIP_MODEL_VERSION,
  ensureClipModel,
  type EnsureModelOptions,
  type ResolvedModelManifest,
} from './models/clipManifest.js';

export class LocalOnnxModel implements QualityModel {
  readonly name = `onnx-clip/${CLIP_MODEL_VERSION}`;

  private manifest?: ResolvedModelManifest;
  private session?: InferenceSession;

  constructor(private readonly options: EnsureModelOptions = {}) {}

  async init(): Promise<void> {
    this.manifest = await ensureClipModel(this.options);
    // Lazy import: the onnxruntime native addon loads only when the onnx backend
    // is actually used, keeping startup (and other commands) free of it.
    const ort = await import('onnxruntime-node');
    // Loading the encoder validates the provisioned model end to end; the
    // session will drive image embedding once scoring is wired.
    this.session = await ort.InferenceSession.create(this.manifest.imageEncoderPath);
  }

  private notWired(): never {
    throw new Error(
      `${this.name}: image encoder loads, but aesthetic/keyword scoring is not wired yet ` +
        `(pending a commercially-clean model). See clipManifest.ts.`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async scoreFocus(_image: ImageInput): Promise<number> {
    return this.notWired();
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async scoreAesthetic(_image: ImageInput): Promise<number> {
    return this.notWired();
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async suggestKeywords(_image: ImageInput): Promise<string[]> {
    return this.notWired();
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async assess(_image: ImageInput): Promise<QualityAssessment> {
    return this.notWired();
  }

  async dispose(): Promise<void> {
    await this.session?.release();
    this.session = undefined;
  }
}
