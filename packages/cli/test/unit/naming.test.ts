/**
 * Target-name planning for `import` and `rename`.
 *
 * The rule that matters: an existing file is never overwritten. Everything else
 * here — sequence order, the `_2` suffix, the unchanged flag — exists to keep
 * that true while still producing the names the photographer asked for.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildNamingPlan, type FileNamingInfo } from '../../src/naming.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'shoots-naming-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const info = (name: string, date: Date, extra: Partial<FileNamingInfo> = {}): FileNamingInfo => ({
  file: {
    path: path.join(dir, name),
    name,
    ext: path.extname(name).slice(1).toLowerCase(),
    kind: 'raw',
    size: 1,
    mtime: date,
  },
  date,
  dateSource: 'exif',
  camera: 'Canon EOS R5',
  lens: 'RF 28mm F2.8',
  ...extra,
});

const here = () => dir;

describe('buildNamingPlan', () => {
  test('numbers the sequence by capture date, not by input order', () => {
    const plan = buildNamingPlan(
      [
        info('c.cr3', new Date(2026, 0, 1, 12, 0, 2)),
        info('a.cr3', new Date(2026, 0, 1, 12, 0, 0)),
        info('b.cr3', new Date(2026, 0, 1, 12, 0, 1)),
      ],
      '{seq:3}.{ext}',
      here,
    );

    expect(plan.map((p) => path.basename(p.source))).toEqual(['a.cr3', 'b.cr3', 'c.cr3']);
    expect(plan.map((p) => path.basename(p.dest))).toEqual(['001.cr3', '002.cr3', '003.cr3']);
  });

  test('breaks a capture-time tie on the source path, so the plan is deterministic', () => {
    const same = new Date(2026, 0, 1, 12, 0, 0);
    const build = (order: string[]) =>
      buildNamingPlan(order.map((n) => info(n, same)), '{seq}.{ext}', here).map((p) =>
        path.basename(p.source),
      );

    expect(build(['b.cr3', 'a.cr3'])).toEqual(['a.cr3', 'b.cr3']);
    expect(build(['a.cr3', 'b.cr3'])).toEqual(['a.cr3', 'b.cr3']);
  });

  test('renders the full template against the capture metadata', () => {
    const plan = buildNamingPlan(
      [info('IMG_9.cr3', new Date(2026, 7, 2, 9, 5, 3))],
      '{date}_{time}_{camera}_{orig}.{ext}',
      here,
    );
    expect(path.basename(plan[0]!.dest)).toBe('20260802_090503_Canon-EOS-R5_IMG_9.cr3');
  });

  test('suffixes a within-batch collision instead of colliding', () => {
    const day = new Date(2026, 0, 1, 12, 0, 0);
    const plan = buildNamingPlan(
      [info('a.cr3', day), info('b.cr3', day), info('c.cr3', day)],
      '{date}.{ext}',
      here,
    );

    expect(plan.map((p) => path.basename(p.dest))).toEqual([
      '20260101.cr3',
      '20260101_2.cr3',
      '20260101_3.cr3',
    ]);
  });

  test('never targets a file that already exists on disk', async () => {
    const dest = await mkdtemp(path.join(tmpdir(), 'shoots-naming-dest-'));
    try {
      await writeFile(path.join(dest, '20260101.cr3'), 'x');
      const plan = buildNamingPlan(
        [info('a.cr3', new Date(2026, 0, 1))],
        '{date}.{ext}',
        () => dest,
      );
      expect(path.basename(plan[0]!.dest)).toBe('20260101_2.cr3');
    } finally {
      await rm(dest, { recursive: true, force: true });
    }
  });

  test('a file already at its own target name is not a collision', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'shoots-naming-self-'));
    try {
      const name = '20260101.cr3';
      await writeFile(path.join(home, name), 'x');
      const self: FileNamingInfo = {
        ...info(name, new Date(2026, 0, 1)),
        file: {
          path: path.join(home, name),
          name,
          ext: 'cr3',
          kind: 'raw',
          size: 1,
          mtime: new Date(2026, 0, 1),
        },
      };
      const plan = buildNamingPlan([self], '{date}.{ext}', () => home);

      expect(path.basename(plan[0]!.dest)).toBe(name);
      expect(plan[0]!.unchanged).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('marks a genuinely renamed file as changed', () => {
    const plan = buildNamingPlan([info('a.cr3', new Date(2026, 0, 1))], '{date}.{ext}', here);
    expect(plan[0]!.unchanged).toBe(false);
  });

  test('detects a collision case-insensitively, as Windows would', () => {
    const day = new Date(2026, 0, 1);
    const plan = buildNamingPlan(
      [info('a.cr3', day), info('b.CR3', day)],
      '{date}.{ext}',
      here,
    );
    // Both render to the same name modulo case: the second must be suffixed.
    expect(plan[1]!.dest.toLowerCase()).not.toBe(plan[0]!.dest.toLowerCase());
    expect(path.basename(plan[1]!.dest)).toMatch(/_2\./);
  });

  test('routes each file through its own destination directory', () => {
    const day = new Date(2026, 0, 1);
    const plan = buildNamingPlan(
      [info('a.cr3', day), info('b.cr3', day)],
      '{date}.{ext}',
      (i) => path.join(dir, path.basename(i.file.name, path.extname(i.file.name))),
    );
    // Different folders, so neither needs a suffix.
    expect(plan.map((p) => path.basename(p.dest))).toEqual(['20260101.cr3', '20260101.cr3']);
    expect(path.dirname(plan[0]!.dest)).not.toBe(path.dirname(plan[1]!.dest));
  });

  test('passes the date source through untouched', () => {
    const plan = buildNamingPlan(
      [info('a.cr3', new Date(2026, 0, 1), { dateSource: 'mtime' })],
      '{date}.{ext}',
      here,
    );
    expect(plan[0]!.dateSource).toBe('mtime');
  });

  test('does not reorder the caller array', () => {
    const infos = [info('b.cr3', new Date(2026, 0, 2)), info('a.cr3', new Date(2026, 0, 1))];
    buildNamingPlan(infos, '{seq}.{ext}', here);
    expect(infos.map((i) => i.file.name)).toEqual(['b.cr3', 'a.cr3']);
  });

  test('plans nothing for an empty batch', () => {
    expect(buildNamingPlan([], '{date}.{ext}', here)).toEqual([]);
  });
});
