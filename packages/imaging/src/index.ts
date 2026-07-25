export {
  runExiftool,
  exiftoolVersion,
  readMetadata,
  writeMetadata,
  writeXmpSidecar,
  extractPreview,
  readOrientation,
  getTagString,
  parseExifDate,
  ExiftoolError,
  ExiftoolNotFoundError,
  type ExifRecord,
  type ReadMetadataOptions,
  type WriteMetadataOptions,
  type RunExiftoolOptions,
} from './exif.js';

export {
  resolveExiftool,
  ensureExiftool,
  ToolMirrorNotConfiguredError,
  type ExiftoolCommand,
  type EnsureExiftoolOptions,
} from './tools/exiftool.js';

export {
  exiftoolManifest,
  EXIFTOOL_VERSION,
  UnsupportedPlatformError,
  type ResolvedExiftoolManifest,
} from './tools/exiftoolManifest.js';

export { sharpVips } from './health.js';

export {
  isRawFile,
  loadRenderableImage,
  generateThumbnail,
  type RenderableImage,
  type ThumbnailOptions,
} from './thumbnail.js';

export {
  laplacianVariance,
  analyzeBlur,
  DEFAULT_BLUR_THRESHOLD,
  DEFAULT_FOCUS_THRESHOLD,
  type FocusMap,
  type LaplacianResult,
  type LaplacianOptions,
  type BlurAnalysis,
  type BlurVerdict,
  type AnalyzeBlurOptions,
} from './blur.js';

export {
  preprocessClip,
  aestheticStats,
  type ClipPreprocessOptions,
  type AestheticStats,
} from './quality.js';
