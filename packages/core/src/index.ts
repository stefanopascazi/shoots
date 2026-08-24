export {
  RAW_EXTENSIONS,
  PROCESSED_EXTENSIONS,
  classifyExtension,
  scanFiles,
  type FileKind,
  type ScannedFile,
  type ScanOptions,
} from './fs/scan.js';

export { sha256File, normalizeSha256 } from './checksum.js';

export {
  shootsHome,
  binDir,
  toolDir,
  modelsDir,
  modelDir,
  cacheDir,
  cacheShootPath,
  profilesDir,
  developHome,
  developExportPath,
  developProfilePath,
  developFeedbackPath,
  developShootsDir,
  developShootDir,
  triageHome,
  triageShootPath,
  labelSetsDir,
  matchHome,
  matchDbPath,
  logsDir,
  configPath,
} from './paths.js';

export {
  downloadFile,
  DownloadError,
  ChecksumError,
  type DownloadOptions,
} from './net/download.js';

export { extractTarGz, ArchiveError } from './archive.js';

export {
  provisionArchive,
  isProvisioned,
  PROVISION_MARKER,
  type ProvisionArchiveOptions,
} from './provision.js';

export { compareSemver } from './semver.js';

export {
  renderTemplate,
  sanitizeToken,
  validateTemplate,
  templateNeedsCaptureMetadata,
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

export { defaultImageConcurrency, defaultModelConcurrency } from './jobs/concurrency.js';

export {
  parsePipelineConfig,
  loadPipelineConfig,
  parseVarOverrides,
  PipelineConfigError,
  PIPELINE_VERSION,
  type PipelineConfig,
  type PipelineStep,
  type PipelineValue,
  type ParseOptions,
} from './pipeline/PipelineConfig.js';

export {
  renderPipelineYaml,
  type SerializeOptions,
} from './pipeline/init/serialize.js';

export {
  type PipelineDraft,
  type DraftStep,
  type DraftVar,
} from './pipeline/init/draft.js';

export {
  defaultOf,
  describeDefault,
  parseAnswer,
  validateAnswer,
  AnswerError,
  type Answers,
  type AnswerValue,
  type Choice,
  type Question,
  type TextQuestion,
  type SelectQuestion,
  type MultiSelectQuestion,
  type ConfirmQuestion,
} from './pipeline/init/questions.js';

export {
  wizardQuestions,
  nextQuestion,
  presetAnswers,
  buildDraft,
  draftHeader,
  makeContext,
  selectedSteps,
  STEP_BLUEPRINTS,
  PRESETS,
  findBlueprint,
  findPreset,
  type CatalogContext,
  type StepBlueprint,
} from './pipeline/init/wizard.js';

export { type Preset, DEFAULT_RENAME_PATTERN as DEFAULT_INIT_RENAME_PATTERN } from './pipeline/init/catalog.js';
