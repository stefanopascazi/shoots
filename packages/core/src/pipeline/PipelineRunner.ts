/**
 * Executes a declarative pipeline against a batch of files.
 *
 * The runner knows nothing about imaging, exiftool, or inference: concrete
 * behavior is injected as step handlers. In a later stage the CLI (or a REST
 * layer) registers handlers that wrap the exact same functions its commands
 * use — keeping this package pure and headless.
 */
import type { PipelineConfig, PipelineStep, PipelineStepType } from './PipelineConfig.js';

export interface PipelineContext {
  /** Directory the pipeline operates in; steps may rebind this (e.g. import sets it to its dest). */
  workingDir: string;
  /** Current file set flowing through the pipeline; steps may replace it. */
  files: string[];
  /** Arbitrary step outputs keyed by step id/type, for downstream steps or the caller. */
  artifacts: Map<string, unknown>;
  dryRun: boolean;
  log: (message: string) => void;
}

export type StepHandler<S extends PipelineStep = PipelineStep> = (
  step: S,
  ctx: PipelineContext,
) => Promise<void>;

export interface StepRunReport {
  type: PipelineStepType;
  id?: string;
  status: 'ok' | 'skipped' | 'failed';
  durationMs: number;
  error?: string;
}

export interface PipelineRunResult {
  ok: boolean;
  steps: StepRunReport[];
  context: PipelineContext;
}

export interface PipelineRunOptions {
  workingDir?: string;
  dryRun?: boolean;
  log?: (message: string) => void;
  /** Stop at the first failing step. Default: true. */
  failFast?: boolean;
}

export class PipelineRunner {
  private readonly handlers = new Map<PipelineStepType, StepHandler>();

  registerHandler<T extends PipelineStepType>(
    type: T,
    handler: StepHandler<Extract<PipelineStep, { type: T }>>,
  ): this {
    this.handlers.set(type, handler as StepHandler);
    return this;
  }

  async run(config: PipelineConfig, options: PipelineRunOptions = {}): Promise<PipelineRunResult> {
    const ctx: PipelineContext = {
      workingDir: options.workingDir ?? process.cwd(),
      files: [],
      artifacts: new Map(),
      dryRun: options.dryRun ?? false,
      log: options.log ?? (() => {}),
    };
    const failFast = options.failFast ?? true;
    const reports: StepRunReport[] = [];
    let ok = true;

    for (const step of config.steps) {
      const started = Date.now();
      if (step.enabled === false) {
        reports.push({ type: step.type, id: step.id, status: 'skipped', durationMs: 0 });
        continue;
      }
      const handler = this.handlers.get(step.type);
      if (!handler) {
        const error = `No handler registered for step type '${step.type}'`;
        reports.push({ type: step.type, id: step.id, status: 'failed', durationMs: 0, error });
        ok = false;
        if (failFast) break;
        continue;
      }
      try {
        ctx.log(`▶ ${step.type}${step.id ? ` (${step.id})` : ''}`);
        await handler(step, ctx);
        reports.push({ type: step.type, id: step.id, status: 'ok', durationMs: Date.now() - started });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        reports.push({ type: step.type, id: step.id, status: 'failed', durationMs: Date.now() - started, error });
        ok = false;
        if (failFast) break;
      }
    }

    return { ok, steps: reports, context: ctx };
  }
}
