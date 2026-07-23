/**
 * Placeholder QualityModel returning deterministic pseudo-scores derived from
 * a hash of the file name. Deterministic on purpose: pipelines and tests get
 * stable, reproducible output until a real ONNX-backed model lands.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ImageInput, QualityAssessment, QualityModel } from './QualityModel.js';

const KEYWORD_POOL = [
  'portrait',
  'landscape',
  'people',
  'outdoor',
  'indoor',
  'golden-hour',
  'candid',
  'detail',
  'group',
  'ceremony',
  'architecture',
  'nature',
  'low-light',
  'action',
  'close-up',
  'wide-angle',
];

function hashBytes(seed: string): Buffer {
  return createHash('sha256').update(seed).digest();
}

export class LocalStubModel implements QualityModel {
  readonly name = 'local-stub/0.1';

  private initialized = false;

  async init(): Promise<void> {
    // A real backend would load ONNX weights here.
    this.initialized = true;
  }

  private seedFor(image: ImageInput): Buffer {
    // Basename (not full path) so results survive moving a folder around.
    return hashBytes(path.basename(image.path).toLowerCase());
  }

  private ensureInit(): void {
    if (!this.initialized) {
      throw new Error(`${this.name}: init() must be called before scoring`);
    }
  }

  async scoreFocus(image: ImageInput): Promise<number> {
    this.ensureInit();
    const h = this.seedFor(image);
    // Bias toward the upper range: most frames from a working pro are usable.
    return 0.35 + (h[0] / 255) * 0.65;
  }

  async scoreAesthetic(image: ImageInput): Promise<number> {
    this.ensureInit();
    const h = this.seedFor(image);
    return h[1] / 255;
  }

  async suggestKeywords(image: ImageInput): Promise<string[]> {
    this.ensureInit();
    const h = this.seedFor(image);
    const count = 2 + (h[2] % 3); // 2–4 keywords
    const keywords: string[] = [];
    for (let i = 0; i < count; i++) {
      const kw = KEYWORD_POOL[h[3 + i] % KEYWORD_POOL.length];
      if (!keywords.includes(kw)) keywords.push(kw);
    }
    return keywords;
  }

  async assess(image: ImageInput): Promise<QualityAssessment> {
    const [focus, aesthetic, keywords] = await Promise.all([
      this.scoreFocus(image),
      this.scoreAesthetic(image),
      this.suggestKeywords(image),
    ]);
    return { focus, aesthetic, keywords };
  }

  async dispose(): Promise<void> {
    this.initialized = false;
  }
}
