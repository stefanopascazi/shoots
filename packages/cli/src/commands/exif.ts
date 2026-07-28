/**
 * shoots exif <path>
 *
 * Read mode (default): batch-read metadata and report it (JSON with --json,
 * summary table otherwise).
 *
 * Write mode (any --set-* flag or --config): batch-write common fields.
 * exiftool's default `_original` backups are kept unless --overwrite-original.
 */
import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { parse as parseYaml } from 'yaml';
import { scanFiles } from '@shoots/core';
import { getTagString, readMetadata, writeMetadata, type ExifRecord } from '@shoots/imaging';
import {
  logError,
  logVerbose,
  makeIo,
  markFailure,
  printHuman,
  printJson,
} from '../io.js';
import { startPhase } from '../progress.js';
import { ensureExiftoolReady } from '../tools.js';

interface ExifOptions {
  tags?: string;
  setCopyright?: string;
  setArtist?: string;
  setKeywords?: string;
  set?: string[];
  config?: string;
  overwriteOriginal?: boolean;
  recursive?: boolean;
  dryRun?: boolean;
  json?: boolean;
  verbose?: boolean;
}

export function registerExifCommand(program: Command): void {
  program
    .command('exif')
    .description('Batch read/write EXIF/IPTC metadata via exiftool')
    .argument('<path>', 'folder (or single file)')
    .option('--tags <list>', 'comma-separated tag names to read (default: common set)')
    .option('--set-copyright <text>', 'write Copyright')
    .option('--set-artist <text>', 'write Artist/Creator')
    .option('--set-keywords <list>', 'write comma-separated Keywords + XMP Subject')
    .option('--set <Tag=Value...>', 'write an arbitrary exiftool tag (repeatable)')
    .option('--config <file>', 'YAML/JSON file with tags to write, e.g. { artist: ..., copyright: ..., keywords: [...] }')
    .option('--overwrite-original', 'skip exiftool\'s _original backup files when writing')
    .option('--no-recursive', 'do not recurse into subdirectories')
    .option('--dry-run', 'show what would be written without touching files')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runExif);
}

const DEFAULT_READ_TAGS = [
  'FileName',
  'DateTimeOriginal',
  'Model',
  'LensModel',
  'ISO',
  'FNumber',
  'ExposureTime',
  'FocalLength',
  'Artist',
  'Copyright',
  'Keywords',
  'Rating',
  'ImageWidth',
  'ImageHeight',
];

async function tagsFromConfig(configPath: string): Promise<Record<string, string | string[]>> {
  const text = await readFile(configPath, 'utf8');
  const doc: unknown = parseYaml(text); // YAML parser also accepts JSON
  if (typeof doc !== 'object' || doc === null) {
    throw new Error(`--config ${configPath}: expected a mapping of tags`);
  }
  const raw = doc as Record<string, unknown>;
  const tags: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    const tag = key === 'artist' ? 'Artist' : key === 'copyright' ? 'Copyright' : key === 'keywords' ? 'Keywords' : key;
    if (Array.isArray(value)) tags[tag] = value.map(String);
    else if (value !== null && value !== undefined) tags[tag] = String(value);
  }
  return tags;
}

function buildWriteTags(options: ExifOptions): Promise<Record<string, string | string[]>> | Record<string, string | string[]> | null {
  const fromFlags: Record<string, string | string[]> = {};
  if (options.setCopyright) fromFlags.Copyright = options.setCopyright;
  if (options.setArtist) fromFlags.Artist = options.setArtist;
  if (options.setKeywords) {
    const keywords = options.setKeywords.split(',').map((k) => k.trim()).filter(Boolean);
    fromFlags.Keywords = keywords;
    fromFlags['XMP:Subject'] = keywords;
  }
  for (const pair of options.set ?? []) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new Error(`--set expects Tag=Value, got: ${pair}`);
    fromFlags[pair.slice(0, eq)] = pair.slice(eq + 1);
  }

  if (options.config) {
    return tagsFromConfig(options.config).then((fromFile) => ({ ...fromFile, ...fromFlags }));
  }
  return Object.keys(fromFlags).length > 0 ? fromFlags : null;
}

async function runExif(targetPath: string, options: ExifOptions): Promise<void> {
  const io = makeIo(options);
  const scanPhase = startPhase(io, 'Scanning');
  const files = await scanFiles(targetPath, {
    recursive: options.recursive ?? true,
    onProgress: (found) => scanPhase.update(`${found} files`),
  });
  scanPhase.done(`${files.length} files`);
  if (files.length === 0) {
    printHuman(io, 'No image files found.');
    if (io.json) printJson({ command: 'exif', files: [] });
    return;
  }
  const paths = files.map((f) => f.path);
  logVerbose(io, `Found ${paths.length} files under ${targetPath}`);

  // Every exif operation shells out to exiftool.
  if (!(await ensureExiftoolReady(io))) return;

  let writeTags: Record<string, string | string[]> | null;
  try {
    writeTags = await buildWriteTags(options);
  } catch (err) {
    logError(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
    return;
  }

  if (writeTags === null) {
    // ---- READ MODE ----
    const tags = options.tags
      ? options.tags.split(',').map((t) => t.trim()).filter(Boolean)
      : DEFAULT_READ_TAGS;
    const readPhase = startPhase(io, 'Reading metadata');
    const records = await readMetadata(paths, {
      tags,
      onProgress: (done, total) => readPhase.update(`${done}/${total}`),
    });
    readPhase.done(`${records.length} files`);
    if (io.json) {
      printJson({ command: 'exif', mode: 'read', files: records });
    } else {
      for (const record of records) {
        printHuman(io, formatRecord(record));
      }
      printHuman(io, `${records.length} files read`);
    }
    return;
  }

  // ---- WRITE MODE ----
  if (options.dryRun) {
    if (io.json) {
      printJson({ command: 'exif', mode: 'write', dryRun: true, tags: writeTags, files: paths });
    } else {
      printHuman(io, 'Would write:');
      for (const [tag, value] of Object.entries(writeTags)) {
        printHuman(io, `  ${tag} = ${Array.isArray(value) ? value.join(', ') : value}`);
      }
      printHuman(io, `to ${paths.length} files (dry run)`);
    }
    return;
  }

  try {
    const summary = await writeMetadata(paths, writeTags, {
      overwriteOriginal: options.overwriteOriginal,
    });
    logVerbose(io, `exiftool: ${summary}`);
    if (io.json) {
      printJson({ command: 'exif', mode: 'write', dryRun: false, tags: writeTags, files: paths, exiftool: summary });
    } else {
      printHuman(io, `Wrote ${Object.keys(writeTags).length} tags to ${paths.length} files (${summary})`);
      if (!options.overwriteOriginal) {
        printHuman(io, 'Originals preserved as *_original backups (exiftool default).');
      }
    }
  } catch (err) {
    logError(err instanceof Error ? err.message : String(err));
    markFailure();
  }
}

function formatRecord(record: ExifRecord): string {
  const parts: string[] = [record.SourceFile];
  const push = (label: string, tag: string) => {
    const value = getTagString(record, tag);
    if (value) parts.push(`${label}=${value}`);
  };
  push('date', 'DateTimeOriginal');
  push('camera', 'Model');
  push('lens', 'LensModel');
  push('iso', 'ISO');
  push('f', 'FNumber');
  push('t', 'ExposureTime');
  const keywords = record.Keywords;
  if (Array.isArray(keywords) && keywords.length > 0) parts.push(`keywords=[${keywords.join(', ')}]`);
  else if (typeof keywords === 'string') parts.push(`keywords=[${keywords}]`);
  return parts.join('  ');
}
