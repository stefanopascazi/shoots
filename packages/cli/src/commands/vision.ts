/**
 * shoots vision <path>
 *
 * Read every photograph in a folder with the vision model — a caption, the
 * objects in it, and where the sky and the subject are — and cache the result
 * for the features built on it (keywords, region intents). Those features run
 * the same pass themselves when a frame is missing, so this command is the
 * up-front, resumable way to pay for it on a whole shoot.
 *
 * The model (630 MB) is fetched on first use.
 */
import type { Command } from 'commander';
import { scanFiles } from '@shoots/core';
import { loadFlorence } from '@shoots/inference';
import { DerivedCache } from '../cache/store.js';
import { visionCached } from '../cache/vision.js';
import { analyzePhotograph } from '../vision/analyze.js';
import { maskShare, type VisionRecord } from '../vision/record.js';
import { keywordsFromVision } from '../vision/keywords.js';
import { ensureExiftoolReady, ensureVisionModelReady } from '../tools.js';
import { logError, logVerbose, makeIo, printHuman, printJson } from '../io.js';
import { startPhase, startProgress } from '../progress.js';

interface VisionOptions {
  cache?: boolean;
  json?: boolean;
  verbose?: boolean;
}

export function registerVisionCommand(program: Command): void {
  program
    .command('vision')
    .description('Read each photograph with the vision model (caption, objects, sky and subject) and cache it for keywords and region intents')
    .argument('<path>', 'folder (or single file) to read')
    .option('--no-cache', 'read every frame again instead of reusing what a previous run found')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runVision);
}

async function runVision(targetPath: string, options: VisionOptions): Promise<void> {
  const io = makeIo(options);
  const scan = startPhase(io, 'Scanning');
  const files = await scanFiles(targetPath, { onProgress: (n) => scan.update(`${n} files`) });
  scan.done(`${files.length} files`);
  if (!files.length) {
    logError(`no photographs under ${targetPath}`);
    process.exitCode = 2;
    return;
  }
  if (!(await ensureExiftoolReady(io))) return;
  const modelDir = await ensureVisionModelReady(io);
  if (!modelDir) return;

  const florence = await loadFlorence(modelDir);
  const cache = await DerivedCache.open(files.map((f) => f.path), { enabled: options.cache !== false });
  const progress = await startProgress(io, files.length, 'Reading');
  const results: { file: string; record: VisionRecord }[] = [];
  const errors: { file: string; error: string }[] = [];
  let reused = 0;
  let done = 0;
  // One at a time: the model already uses every core, and two concurrent runs
  // only contend for them.
  for (const f of files) {
    try {
      const { record, cached } = await visionCached(cache, f.path, { size: f.size, mtimeMs: f.mtime.getTime() }, () => analyzePhotograph(florence, f.path));
      if (cached) reused++;
      results.push({ file: f.path, record });
    } catch (err) {
      errors.push({ file: f.path, error: err instanceof Error ? err.message : String(err) });
    }
    progress.onProgress({ completed: ++done, total: files.length, label: f.name });
  }
  progress.stop();
  await cache.save();
  logVerbose(io, `Cache: ${reused} reused, ${results.length - reused} read`);

  if (io.json) {
    printJson({
      command: 'vision',
      results: results.map(({ file, record }) => ({ file, keywords: keywordsFromVision(record), ...record })),
      errors,
      summary: { total: files.length, read: results.length, reused, failed: errors.length },
    });
    return;
  }
  const withSky = results.filter((r) => r.record.regions.sky).length;
  const withSubject = results.filter((r) => r.record.regions.subject).length;
  printHuman(io, `Read ${results.length} photographs (${reused} from cache): sky in ${withSky}, a person in ${withSubject}.`);
  for (const { file, record } of results.slice(0, 3)) {
    const regions = Object.entries(record.regions).map(([k, v]) => `${k} ${Math.round(maskShare(v!) * 100)}%`).join(', ');
    printHuman(io, `  ${file.split(/[\\/]/).pop()}: ${keywordsFromVision(record).join(', ') || '(no keywords)'}${regions ? `  [${regions}]` : ''}`);
  }
  for (const e of errors) logError(`${e.file}: ${e.error}`);
}
