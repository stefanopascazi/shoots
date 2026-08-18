/**
 * What the wizard produces: a pipeline file before it is text.
 *
 * Kept separate from {@link PipelineConfig} on purpose — a config is what the
 * runner loads (interpolated, validated, every field filled in), a draft is what
 * an author writes (`${raw}` still a reference, comments still attached).
 */
import type { PipelineValue } from '../PipelineConfig.js';

export interface DraftStep {
  id: string;
  run: string;
  args: string[];
  with: Record<string, PipelineValue>;
  /** Written above the step, as a `#` line. */
  comment?: string;
}

export interface DraftVar {
  name: string;
  value: string;
  comment?: string;
}

export interface PipelineDraft {
  name?: string;
  vars: DraftVar[];
  defaults: Record<string, PipelineValue>;
  steps: DraftStep[];
}
