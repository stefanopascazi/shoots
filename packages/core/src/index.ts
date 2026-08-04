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
