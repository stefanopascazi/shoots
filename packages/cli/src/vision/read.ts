/**
 * Vision records for a set of photographs: from the cache where `shoots vision`
 * (or an earlier run) left them, otherwise read now.
 *
 * The model is loaded only if some frame is missing, and fetched only if it is
 * not installed yet — a shoot already read costs nothing but the cache lookup.
 */
import { stat } from 'node:fs/promises';
import { ensureFlorenceModel, loadFlorence, type Florence } from '@shoots/inference';
import { DerivedCache } from '../cache/store.js';
import { visionCached } from '../cache/vision.js';
import { analyzePhotograph } from './analyze.js';
import type { VisionRecord } from './record.js';

export async function readVision(files: readonly string[], log: (message: string) => void): Promise<Map<string, VisionRecord>> {
  const cache = await DerivedCache.open(files);
  const out = new Map<string, VisionRecord>();
  let florence: Florence | null = null;
  let read = 0;
  for (const file of files) {
    try {
      const s = await stat(file);
      const { record, cached } = await visionCached(cache, file, { size: s.size, mtimeMs: s.mtimeMs }, async () => {
        if (!florence) {
          log('Reading photographs with the vision model (cached for next time; `shoots vision` does it ahead)…');
          const m = await ensureFlorenceModel({ onStatus: log });
          florence = await loadFlorence(m.installDir);
        }
        return analyzePhotograph(florence, file);
      });
      out.set(file, record);
      if (!cached && ++read % 10 === 0) log(`  ${read} read`);
    } catch (err) {
      log(`warn: ${file}: no vision record — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await cache.save();
  return out;
}
