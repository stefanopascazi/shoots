export {
  RAW_EXTENSIONS,
  PROCESSED_EXTENSIONS,
  classifyExtension,
  scanFiles,
  type FileKind,
  type ScannedFile,
  type ScanOptions,
} from './fs/scan.js';

export { sha256File } from './checksum.js';

export {
  renderTemplate,
  sanitizeToken,
  validateTemplate,
  TemplateError,
  type TemplateContext,
} from './template.js';

export {
  JobQueue,
  type JobOutcome,
  type JobProgress,
  type JobQueueOptions,
  type ProgressListener,
} from './jobs/JobQueue.js';

export {
  parsePipelineConfig,
  loadPipelineConfig,
  PipelineConfigError,
  type PipelineConfig,
  type PipelineStep,
  type PipelineStepType,
  type ImportStep,
  type ExifStep,
  type CullStep,
  type RateStep,
  type ExportStep,
} from './pipeline/PipelineConfig.js';

export {
  PipelineRunner,
  type PipelineContext,
  type PipelineRunOptions,
  type PipelineRunResult,
  type StepHandler,
  type StepRunReport,
} from './pipeline/PipelineRunner.js';
