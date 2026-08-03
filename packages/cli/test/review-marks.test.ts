/**
 * The interactive review, in mark mode.
 *
 * This path shipped broken: `commitDecision` only knew how to relocate, so the
 * shell had to demand a --dest even when the run was marking and nothing would
 * ever be written there. The review UI itself is Ink and is not driven here —
 * what is driven is the service beneath it, which is where the defect was.
 */
import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { makeSandbox } from './fixtures.js';
import { runTriage, commitDecision } from '../src/shell/triage/triageService.js';
import { readMarks } from '../src/triage/store.js';

/** Everything soft, nothing rescued away: every frame reaches the review queue. */
const ALL_UNCERTAIN = { threshold: 100000, focusThreshold: 0 };

describe('runTriage in mark mode', () => {
  test('needs no destination and moves nothing', async () => {
    const sandbox = await makeSandbox();
    process.env.SHOOTS_HOME = sandbox.home;
    try {
      const res = await runTriage(sandbox.catalog, { mark: { label: 'reject' }, ...ALL_UNCERTAIN });

      expect(res.dest).toBeNull();
      expect(res.mark).toEqual({ label: 'reject', keepers: undefined });

      const before = await readdir(path.join(sandbox.catalog, '2026', '2026-08-02'));
      expect(before).toContain('IMG_0001.jpg');
    } finally {
      await sandbox.dispose();
    }
  });

  test('refuses a run configured with neither a destination nor a label', async () => {
    const sandbox = await makeSandbox();
    process.env.SHOOTS_HOME = sandbox.home;
    try {
      expect(runTriage(sandbox.catalog, ALL_UNCERTAIN)).rejects.toThrow(/destination or a mark label/);
    } finally {
      await sandbox.dispose();
    }
  });
});

describe('commitDecision in mark mode', () => {
  test('records both verdicts, leaves every file where it is', async () => {
    const sandbox = await makeSandbox();
    process.env.SHOOTS_HOME = sandbox.home;
    try {
      const mark = { label: 'reject' as const, keepers: 'select' as const };
      const res = await runTriage(sandbox.catalog, { mark, ...ALL_UNCERTAIN });
      expect(res.review.length).toBe(2);

      await commitDecision(sandbox.catalog, { mark }, res.review[0]!.file, 'keep', { move: true });
      await commitDecision(sandbox.catalog, { mark }, res.review[1]!.file, 'discard', { move: true });

      const marks = await readMarks(res.review.map((r) => r.file));
      expect(marks.size).toBe(2);

      const kept = marks.get(path.resolve(res.review[0]!.file))!;
      const discarded = marks.get(path.resolve(res.review[1]!.file))!;
      expect(kept.marks).toMatchObject({ reject: false, label: 'select' });
      expect(discarded.marks).toMatchObject({ reject: true, label: 'reject' });

      // A decision somebody actually looked at must not read like one a
      // threshold produced.
      expect(kept.sources.cull?.reviewed).toBe(true);
      expect(discarded.sources.cull?.reviewed).toBe(true);

      for (const day of ['2026-08-02', '2026-08-03']) {
        expect(await readdir(path.join(sandbox.catalog, '2026', day))).toContain('IMG_0001.jpg');
      }
    } finally {
      await sandbox.dispose();
    }
  });

  test('keeping records nothing when no keeper label was configured', async () => {
    const sandbox = await makeSandbox();
    process.env.SHOOTS_HOME = sandbox.home;
    try {
      const mark = { label: 'reject' as const };
      const res = await runTriage(sandbox.catalog, { mark, ...ALL_UNCERTAIN });

      await commitDecision(sandbox.catalog, { mark }, res.review[0]!.file, 'keep', { move: true });

      const marks = await readMarks([res.review[0]!.file]);
      expect(marks.size).toBe(0);
    } finally {
      await sandbox.dispose();
    }
  });
});
