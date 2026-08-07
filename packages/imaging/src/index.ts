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
  ExiftoolDaemon,
  sharedExiftoolDaemon,
  closeExiftoolDaemon,
  type DaemonResult,
} from './tools/exiftoolDaemon.js';

export {
  exiftoolManifest,
  EXIFTOOL_VERSION,
  UnsupportedPlatformError,
  type ResolvedExiftoolManifest,
} from './tools/exiftoolManifest.js';

export {
  resolveLibraw,
  ensureLibraw,
  LibrawMirrorNotConfiguredError,
  type EnsureLibrawOptions,
} from './tools/libraw.js';

export {
  librawManifest,
  LIBRAW_VERSION,
  type ResolvedLibrawManifest,
} from './tools/librawManifest.js';

export { sharpVips } from './health.js';
export { encodeJpeg, rawPixels } from './encode.js';

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
  measureBlur,
  classifyBlur,
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

export {
  extractColorFeatures,
  COLOR_FEATURE_NAMES,
  type ColorFeatures,
} from './features.js';

export {
  readFloatDng,
  isFloatDng,
  floatDngToSrgb8,
  renderFloatDngNeutral,
  type DngCalibration,
  type FloatDngImage,
  type FloatDngOptions,
} from './floatDng.js';
