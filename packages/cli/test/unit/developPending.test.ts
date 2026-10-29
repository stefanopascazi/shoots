import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { pendingFrom } from '../../src/develop/pending.js';
import type { PredictionRecord } from '../../src/develop/shoot.js';

const record = (folder: string | undefined, at: string, files: Array<[string, string?]>): PredictionRecord => ({
  command: 'develop-predict',
  at,
  profile: 'p',
  ...(folder ? { folder } : {}),
  predictions: files.map(([file, predictedAt]) => ({ file, treatment: 'color', develop: {}, render: undefined, ...(predictedAt ? { predictedAt } : {}) })),
});

describe('pendingFrom', () => {
  test('a photo learned after its prediction no longer waits', () => {
    const shoots = pendingFrom(
      [record('/s/rome', '2026-10-01T00:00:00Z', [['/s/rome/a.CR3'], ['/s/rome/b.CR3']])],
      new Map([['/s/rome/a.CR3', '2026-10-02T00:00:00Z']]),
    );
    expect(shoots).toEqual([{ folder: '/s/rome', pending: 1, developedAt: '2026-10-01T00:00:00Z' }]);
  });

  test('developed again after learning waits again; a learned shoot is not listed', () => {
    const learned = new Map([['/s/a.CR3', '2026-10-02T00:00:00Z'], ['/s/b.CR3', '2026-10-02T00:00:00Z']]);
    expect(pendingFrom([record('/s', '2026-10-01T00:00:00Z', [['/s/a.CR3'], ['/s/b.CR3']])], learned)).toEqual([]);
    expect(pendingFrom([record('/s', '2026-10-01T00:00:00Z', [['/s/a.CR3', '2026-10-03T00:00:00Z']])], learned)[0]!.pending).toBe(1);
  });

  test('a record without a folder names the one holding its photos; newest first', () => {
    const shoots = pendingFrom(
      [
        record(undefined, '2026-10-01T00:00:00Z', [['/p/x/1.CR3'], ['/p/x/sub/2.CR3']]),
        record('/q', '2026-10-05T00:00:00Z', [['/q/3.CR3']]),
      ],
      new Map(),
    );
    expect(shoots.map((s) => s.folder)).toEqual(['/q', path.dirname('/p/x/1.CR3')]);
  });
});
