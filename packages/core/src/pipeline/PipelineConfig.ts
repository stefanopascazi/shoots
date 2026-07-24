/**
 * Declarative pipeline configuration for `shoots run <config.yaml>`.
 *
 * NOTE: the `run` command itself lands in a later stage. These types and the
 * YAML loader are scaffolding so pipelines can be authored/versioned today
 * and executed unchanged later.
 */
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

export interface PipelineConfig {
  /** Config schema version. Currently always 1. */
  version: 1;
  /** Optional human-readable pipeline name. */
  name?: string;
  steps: PipelineStep[];
}

export type PipelineStep = ImportStep | ExifStep | CullStep | RateStep | ExportStep;

export type PipelineStepType = PipelineStep['type'];

interface BaseStep {
  /** Optional stable identifier, useful for logs and resume-from-step later. */
  id?: string;
  /** Set false to skip without deleting the step. Default: true. */
  enabled?: boolean;
}

export interface ImportStep extends BaseStep {
  type: 'import';
  source: string;
  dest: string;
  /** Filename template, same tokens as `shoots import --pattern`. */
  pattern?: string;
  /** Move instead of copy (source deleted only after checksum verification). Default: false. */
  move?: boolean;
}

export interface ExifStep extends BaseStep {
  type: 'exif';
  /** Tags to write in batch. Well-known keys plus arbitrary exiftool tag names. */
  set: {
    artist?: string;
    copyright?: string;
    keywords?: string[];
    [tag: string]: unknown;
  };
}

export interface CullStep extends BaseStep {
  type: 'cull';
  /** Laplacian-variance threshold below which a file is considered blurry. */
  threshold?: number;
  /** Copy files into sharp/ and blurry/ subfolders of `dest`. Default: false (report only). */
  separate?: boolean;
  dest?: string;
}

export interface RateStep extends BaseStep {
  type: 'rate';
  /** Inference backend. Only 'onnx' today; kept open for future backends. */
  model?: 'onnx';
  /** Where ratings are written. Default: sidecar. */
  output?: 'sidecar' | 'xmp';
}

/** Future stage — declared now so configs are forward-compatible. */
export interface ExportStep extends BaseStep {
  type: 'export';
  format?: 'jpeg' | 'png' | 'webp';
  maxDimension?: number;
  quality?: number;
  dest: string;
}

export class PipelineConfigError extends Error {}

const STEP_TYPES: readonly string[] = ['import', 'exif', 'cull', 'rate', 'export'];

function assertString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PipelineConfigError(`${where} must be a non-empty string`);
  }
  return value;
}

/** Parse and structurally validate a pipeline config from YAML text. */
export function parsePipelineConfig(yamlText: string): PipelineConfig {
  const doc: unknown = parseYaml(yamlText);
  if (typeof doc !== 'object' || doc === null) {
    throw new PipelineConfigError('Pipeline config must be a YAML mapping');
  }
  const raw = doc as Record<string, unknown>;
  if (raw.version !== 1) {
    throw new PipelineConfigError(`Unsupported pipeline config version: ${String(raw.version)} (expected 1)`);
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new PipelineConfigError('Pipeline config must declare a non-empty `steps` list');
  }

  raw.steps.forEach((step: unknown, i: number) => {
    const where = `steps[${i}]`;
    if (typeof step !== 'object' || step === null) {
      throw new PipelineConfigError(`${where} must be a mapping`);
    }
    const s = step as Record<string, unknown>;
    if (typeof s.type !== 'string' || !STEP_TYPES.includes(s.type)) {
      throw new PipelineConfigError(
        `${where}.type must be one of: ${STEP_TYPES.join(', ')} (got ${String(s.type)})`,
      );
    }
    switch (s.type) {
      case 'import':
        assertString(s.source, `${where}.source`);
        assertString(s.dest, `${where}.dest`);
        break;
      case 'exif':
        if (typeof s.set !== 'object' || s.set === null) {
          throw new PipelineConfigError(`${where}.set must be a mapping of tags to write`);
        }
        break;
      case 'export':
        assertString(s.dest, `${where}.dest`);
        break;
      // cull / rate: all fields optional
    }
  });

  return raw as unknown as PipelineConfig;
}

export async function loadPipelineConfig(filePath: string): Promise<PipelineConfig> {
  const text = await readFile(filePath, 'utf8');
  return parsePipelineConfig(text);
}
