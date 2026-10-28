import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCleanup, parseCleanupParts, summarize, type CleanedEntry } from '../../src/app/cleanup.js';
import { DurableJobs } from '../../src/app/durableJobs.js';
import type { CleanPart } from '../../src/develop/commands/clean.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A jobs folder holding one finished job, an exports folder holding one export, and a develop cleaner that records its calls. */
async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'shoots-cleanup-'));
  roots.push(root);
  const jobsDir = path.join(root, 'jobs');
  const durable = new DurableJobs(jobsDir, { processes: { alive: () => false, kill: () => {} } });
  const job = durable.start({ kind: 'catalog', folder: 'F' });
  await durable.provideCatalog(job.id, JSON.stringify({ version: 1, folder: 'F', photos: [] }));
  const calls: Array<{ parts: CleanPart[]; dryRun: boolean }> = [];
  const develop = async (parts: CleanPart[], dryRun: boolean): Promise<CleanedEntry[]> => {
    calls.push({ parts, dryRun });
    return parts.includes('shoots') ? [{ part: 'shoots', bytes: 10 }, { part: 'shoots', bytes: 5 }] : [];
  };
  return { durable, calls, cleanup: createCleanup(durable, develop), exportsDir: path.join(root, 'exports'), jobsDir };
}

describe('parseCleanupParts', () => {
  test('keeps known parts once', () => {
    expect(parseCleanupParts(['journal', 'jobs', 'jobs', 'cache', 3])).toEqual(['journal', 'jobs']);
    expect(parseCleanupParts('jobs')).toEqual([]);
  });
});

describe('summarize', () => {
  test('one line per part', () => {
    expect(summarize([{ part: 'shoots', bytes: 1 }, { part: 'shoots', bytes: 2 }, { part: 'profile', bytes: 4 }])).toEqual([
      { part: 'shoots', count: 2, bytes: 3 },
      { part: 'profile', count: 1, bytes: 4 },
    ]);
  });
});

describe('cleanup', () => {
  test('preview measures every part and removes nothing', async () => {
    const { cleanup, calls, exportsDir } = await setup();
    const items = await cleanup.preview();
    expect(calls).toEqual([{ parts: ['shoots', 'dataset', 'profile', 'calibration', 'journal'], dryRun: true }]);
    expect(items.find((i) => i.part === 'shoots')).toEqual({ part: 'shoots', count: 2, bytes: 15 });
    expect(items.find((i) => i.part === 'jobs')!.count).toBe(1);
    expect(items.find((i) => i.part === 'exports')!.count).toBe(1);
    expect(existsSync(exportsDir)).toBe(true);
  });

  test('run hands develop parts to develop clean and clears the app history', async () => {
    const { cleanup, calls, durable, exportsDir } = await setup();
    const removed = await cleanup.run(['journal', 'jobs', 'exports']);
    expect(calls).toEqual([{ parts: ['journal'], dryRun: false }]);
    expect(removed.map((r) => r.part).sort()).toEqual(['exports', 'jobs']);
    expect(durable.latest()).toBeUndefined();
    expect(existsSync(exportsDir)).toBe(false);
  });

  test('a running job keeps its folder', async () => {
    const { cleanup, durable, jobsDir } = await setup();
    const waiting = durable.start({ kind: 'train', folder: 'F' });
    await cleanup.run(['jobs']);
    expect(existsSync(path.join(jobsDir, waiting.id))).toBe(true);
    expect(durable.get(waiting.id)!.state).toBe('running');
  });

  test('app-only parts never call develop clean', async () => {
    const { cleanup, calls } = await setup();
    await cleanup.run(['jobs']);
    expect(calls).toEqual([]);
  });
});
