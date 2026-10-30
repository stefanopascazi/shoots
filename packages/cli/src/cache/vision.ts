/**
 * The cached vision record, shared by keywords and region intents.
 *
 * Several seconds of model time per photograph, so it is computed once per frame
 * and file version and reused by every command that needs it.
 */
import { FLORENCE_MODEL_VERSION } from '@shoots/inference';
import { readRecord, type VisionRecord } from '../vision/record.js';
import { visionProducer } from './producers.js';
import type { DerivedCache, FileIdentity } from './store.js';

export async function visionCached(
  cache: DerivedCache,
  file: string,
  identity: FileIdentity,
  compute: () => Promise<VisionRecord>,
): Promise<{ record: VisionRecord; cached: boolean }> {
  const producer = visionProducer(FLORENCE_MODEL_VERSION);
  const hit = readRecord(cache.get<unknown>(file, producer, identity));
  if (hit) return { record: hit, cached: true };
  const record = await compute();
  cache.set(file, producer, identity, record);
  await cache.flushIfDue();
  return { record, cached: false };
}

/** The cached record if a run already read this file version; never runs the model. */
export function visionLookup(cache: DerivedCache, file: string, identity: FileIdentity): VisionRecord | null {
  return readRecord(cache.get<unknown>(file, visionProducer(FLORENCE_MODEL_VERSION), identity));
}
