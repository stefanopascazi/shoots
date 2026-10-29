/**
 * Shoots developed with shoots that the profile has not learned from yet: what
 * the app lists so the loop is not forgotten. A prediction counts as learned
 * once `learn` folded its photograph in after it was made.
 */
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PendingShoot } from '@shoots/app';
import { developFeedbackPath, developShootsDir } from '@shoots/core';
import { loadJournal } from './feedback/journal.js';
import type { PredictionRecord } from './shoot.js';

/** The deepest folder holding every file, or undefined when they share none. */
function commonFolder(files: readonly string[]): string | undefined {
  let common = files[0] === undefined ? undefined : path.dirname(files[0]);
  for (const f of files.slice(1)) {
    while (common && path.relative(common, f).startsWith('..')) {
      const up = path.dirname(common);
      common = up === common ? undefined : up;
    }
  }
  return common;
}

/** Pure: which of these prediction records still wait, given when each photo was learned. */
export function pendingFrom(records: readonly PredictionRecord[], learnedAt: ReadonlyMap<string, string>): PendingShoot[] {
  const out: PendingShoot[] = [];
  for (const record of records) {
    const waiting = (record.predictions ?? []).filter((p) => {
      const learned = learnedAt.get(p.file);
      const made = p.predictedAt ?? record.at;
      return learned === undefined || Date.parse(made) > Date.parse(learned);
    });
    const folder = record.folder ?? commonFolder(record.predictions.map((p) => p.file));
    if (waiting.length === 0 || !folder) continue;
    const developedAt = waiting.map((p) => p.predictedAt ?? record.at).sort().at(-1)!;
    out.push({ folder, pending: waiting.length, developedAt });
  }
  return out.sort((a, b) => b.developedAt.localeCompare(a.developedAt));
}

export async function pendingShoots(): Promise<PendingShoot[]> {
  const root = developShootsDir();
  if (!existsSync(root)) return [];
  const records: PredictionRecord[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name, 'prediction.json');
    if (!entry.isDirectory() || !existsSync(file)) continue;
    try {
      records.push(JSON.parse(await readFile(file, 'utf8')) as PredictionRecord);
    } catch {
      // A torn record is skipped, not fatal to the list.
    }
  }
  const learnedAt = new Map<string, string>();
  for (const o of await loadJournal(developFeedbackPath())) if (o.trainedAt) learnedAt.set(o.file, o.trainedAt);
  return pendingFrom(records, learnedAt);
}
