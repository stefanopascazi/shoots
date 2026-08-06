/**
 * The cull → rate → sidecar cycle, end to end, on a nested catalog.
 *
 * Every assertion here exists because the thing it checks broke in real use:
 * sidecars piling up flat in the root instead of beside their photographs, two
 * days' worth of `IMG_0001` collapsing onto one file, a develop write erasing
 * the label somebody had just recorded, marks silently never reaching anything.
 *
 * Driven through the built CLI rather than by importing functions, because every
 * one of those defects was in the wiring — which flag reaches which argument —
 * and a test that imports past the wiring cannot see them.
 */
import { describe, expect, test, beforeAll } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { EXIFTOOL, makeSandbox, sidecar, type Sandbox } from './fixtures.js';

const CLI = path.resolve(import.meta.dir, '../dist/cli.js');

/**
 * Spawning node and shelling out to exiftool once per file is seconds, not
 * milliseconds; the default 5s budget is for pure functions.
 */
const SLOW = 60_000;

/** Writing XMP needs exiftool. Without one, say so rather than fail. */
const xmpTest = EXIFTOOL ? test : test.skip;

/** Run the built CLI and return its streams. Never throws on a non-zero exit. */
async function cli(sandbox: Sandbox, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(['node', CLI, ...args], {
    env: sandbox.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

/** Everything is culled as blurry at this threshold — the verdict is not what is under test. */
const ALL_BLURRY = ['--threshold', '100000'];

beforeAll(() => {
  if (!existsSync(CLI)) {
    throw new Error(`built CLI missing at ${CLI} — run \`npm run build -w @shoots/cli\` first`);
  }
});

describe('cull --mark', () => {
  test('records marks without writing anything next to the photographs', async () => {
    const sandbox = await makeSandbox();
    try {
      const { code, out } = await cli(sandbox, 'cull', sandbox.catalog, ...ALL_BLURRY, '--mark');
      expect(code).toBe(0);
      expect(out).toContain('marked 2 files');

      // The whole point of a mark: the catalog is untouched.
      for (const day of ['2026-08-02', '2026-08-03']) {
        expect(existsSync(sidecar(sandbox, day))).toBe(false);
      }
      const store = await readdir(path.join(sandbox.home, 'triage'));
      expect(store.length).toBe(1);
    } finally {
      await sandbox.dispose();
    }
  });

  test('marks survive a relocation to --dest', async () => {
    const sandbox = await makeSandbox();
    try {
      const rejects = path.join(sandbox.catalog, '..', 'rejects');
      await cli(sandbox, 'cull', sandbox.catalog, ...ALL_BLURRY, '--mark', '--dest', rejects);

      const storeDir = path.join(sandbox.home, 'triage');
      const [file] = await readdir(storeDir);
      const records = (await readFile(path.join(storeDir, file!), 'utf8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { file: string });

      // Keyed by path: a move nobody reported would leave these pointing at
      // files that no longer exist.
      expect(records.length).toBe(2);
      for (const r of records) {
        expect(existsSync(r.file)).toBe(true);
        expect(r.file.startsWith(path.resolve(rejects))).toBe(true);
      }
    } finally {
      await sandbox.dispose();
    }
  });
});

describe('triage apply', () => {
  xmpTest('writes one sidecar beside each photograph, never flat in the root', async () => {
    const sandbox = await makeSandbox();
    try {
      await cli(sandbox, 'cull', sandbox.catalog, ...ALL_BLURRY, '--mark');
      const { code, out } = await cli(sandbox, 'triage', 'apply', sandbox.catalog);
      expect(code).toBe(0);
      expect(out).toContain('2 sidecar(s) written');

      // Beside each image…
      for (const day of ['2026-08-02', '2026-08-03']) {
        expect(existsSync(sidecar(sandbox, day))).toBe(true);
      }
      // …and the two same-named frames did not collapse onto one file.
      const rootEntries = await readdir(sandbox.catalog, { withFileTypes: true });
      expect(rootEntries.filter((e) => e.isFile())).toEqual([]);
    } finally {
      await sandbox.dispose();
    }
  });

  xmpTest('the sidecar carries the label in the editor vocabulary', async () => {
    const sandbox = await makeSandbox();
    try {
      await cli(sandbox, 'cull', sandbox.catalog, ...ALL_BLURRY, '--mark');
      await cli(sandbox, 'triage', 'apply', sandbox.catalog);

      const xmp = await readFile(sidecar(sandbox, '2026-08-02'), 'utf8');
      expect(xmp).toContain('<xmp:Label>Red</xmp:Label>');
    } finally {
      await sandbox.dispose();
    }
  });

  xmpTest('a user label set remaps the vocabulary without touching the marks', async () => {
    const sandbox = await makeSandbox();
    try {
      await cli(sandbox, 'cull', sandbox.catalog, ...ALL_BLURRY, '--mark');
      const labels = path.join(sandbox.home, 'labels');
      await Bun.write(path.join(labels, 'acr.json'), '{ "reject": "Rosso" }');

      await cli(sandbox, 'triage', 'apply', sandbox.catalog);
      const xmp = await readFile(sidecar(sandbox, '2026-08-02'), 'utf8');
      expect(xmp).toContain('<xmp:Label>Rosso</xmp:Label>');
    } finally {
      await sandbox.dispose();
    }
  });

  xmpTest('a mark consumed against the wrong sidecar is re-applied to the right one', async () => {
    const sandbox = await makeSandbox();
    try {
      await cli(sandbox, 'cull', sandbox.catalog, ...ALL_BLURRY, '--mark');
      await cli(sandbox, 'triage', 'apply', sandbox.catalog);

      // Rewrite history the way a run with a broken sidecar location left it:
      // consumed, but pointing at a file in the catalog root rather than beside
      // the photograph. Every mark then reads as delivered and nothing would
      // ever write them again.
      const storeDir = path.join(sandbox.home, 'triage');
      const [name] = await readdir(storeDir);
      const storeFile = path.join(storeDir, name!);
      const rewritten = (await readFile(storeFile, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => {
          const rec = JSON.parse(line) as { file: string; applied?: { at: string; sidecar: string } };
          rec.applied = {
            at: new Date().toISOString(),
            sidecar: path.join(sandbox.catalog, `${path.parse(rec.file).name}.xmp`),
          };
          return JSON.stringify(rec);
        })
        .join('\n');
      await Bun.write(storeFile, rewritten + '\n');

      // Delete the correctly-placed sidecars so only a re-application can bring
      // the labels back.
      for (const day of ['2026-08-02', '2026-08-03']) await rm(sidecar(sandbox, day));

      const { out } = await cli(sandbox, 'triage', 'apply', sandbox.catalog);
      expect(out).toContain('2 sidecar(s) written');
      for (const day of ['2026-08-02', '2026-08-03']) {
        expect(await readFile(sidecar(sandbox, day), 'utf8')).toContain('<xmp:Label>Red</xmp:Label>');
      }
    } finally {
      await sandbox.dispose();
    }
  });

  xmpTest('applied marks are consumed, and --redo brings them back', async () => {
    const sandbox = await makeSandbox();
    try {
      await cli(sandbox, 'cull', sandbox.catalog, ...ALL_BLURRY, '--mark');
      await cli(sandbox, 'triage', 'apply', sandbox.catalog);

      const second = await cli(sandbox, 'triage', 'apply', sandbox.catalog);
      expect(second.out).toContain('Nothing pending');

      // Soft consume: the decision survives so a discarded sidecar can be rebuilt.
      const redo = await cli(sandbox, 'triage', 'apply', sandbox.catalog, '--redo');
      expect(redo.out).toContain('2 sidecar(s) written');
    } finally {
      await sandbox.dispose();
    }
  });
});

describe('a develop write landing on an annotated sidecar', () => {
  xmpTest('keeps the label, the rating and the keywords', async () => {
    const sandbox = await makeSandbox();
    try {
      await cli(sandbox, 'cull', sandbox.catalog, ...ALL_BLURRY, '--mark');
      await cli(sandbox, 'triage', 'apply', sandbox.catalog);

      const target = sidecar(sandbox, '2026-08-02');
      // Seed the rating and keywords directly rather than through `rate --mark`,
      // which would drag the CLIP model into the suite. The guarantee under test
      // is that *whatever* the sidecar held survives — the photographer's own
      // stars and captions included, not only what Shoots put there.
      const { writeMetadata } = await import('@shoots/imaging');
      await writeMetadata([target], {
        'XMP:Rating': 4,
        'XMP:Subject': ['ceremony', 'backlit'],
        'XMP:Title': 'First dance',
      }, { overwriteOriginal: true });

      // Stand in for `develop edit`, which needs a trained profile and the
      // models: the adapter's write path is the code predict actually calls.
      const { acrAdapter } = await import('../src/develop/adapters/acr/index.js');
      await acrAdapter.writeEdit!(
        { develop: { Exposure2012: 0.35, Contrast2012: 12 }, treatment: 'color' },
        target,
      );

      const xmp = await readFile(target, 'utf8');
      expect(xmp).toContain('Exposure2012');               // the prediction landed
      expect(xmp).toContain('<xmp:Label>Red</xmp:Label>'); // and erased none of this
      expect(xmp).toContain('<xmp:Rating>4</xmp:Rating>');
      expect(xmp).toContain('ceremony');
      expect(xmp).toContain('First dance');
    } finally {
      await sandbox.dispose();
    }
  });

  test('does not invent a sidecar merge when there is nothing to preserve', async () => {
    const sandbox = await makeSandbox();
    try {
      const { acrAdapter } = await import('../src/develop/adapters/acr/index.js');
      const target = sidecar(sandbox, '2026-08-03');
      await acrAdapter.writeEdit!({ develop: { Exposure2012: 0.5 }, treatment: 'color' }, target);

      const xmp = await readFile(target, 'utf8');
      expect(xmp).toContain('Exposure2012');
      expect(xmp).not.toContain('xmp:Label');
    } finally {
      await sandbox.dispose();
    }
  });
});

/**
 * The same cycle through a second editor.
 *
 * Two things are under test that the ACR run cannot see. First, that `--editor`
 * reaches the whole path — the mark store is editor-agnostic, so a triage run
 * that quietly kept writing `.xmp` would still pass every assertion above.
 * Second, that develop settings and annotations can share one file: RapidRAW
 * keeps both in the same `.rrdata`, so the write that lands second is the one
 * that gets to eat the first.
 *
 * No `xmpTest` guard: not needing exiftool is the point.
 */
describe('the same cycle, through RapidRAW', () => {
  /** RapidRAW keeps the extension: `IMG_0001.jpg` → `IMG_0001.jpg.rrdata`. */
  const rrdata = (sandbox: Sandbox, day: string): string =>
    path.join(sandbox.catalog, '2026', day, 'IMG_0001.jpg.rrdata');

  test('writes .rrdata beside each photograph and no .xmp anywhere', async () => {
    const sandbox = await makeSandbox();
    try {
      await cli(sandbox, 'cull', sandbox.catalog, ...ALL_BLURRY, '--mark');
      const { code, out } = await cli(sandbox, 'triage', 'apply', sandbox.catalog, '--editor', 'rapidraw');
      expect(code).toBe(0);
      expect(out).toContain('2 sidecar(s) written');

      for (const day of ['2026-08-02', '2026-08-03']) {
        expect(existsSync(rrdata(sandbox, day))).toBe(true);
        // The ACR convention must not have leaked through.
        expect(existsSync(sidecar(sandbox, day))).toBe(false);
      }
    } finally {
      await sandbox.dispose();
    }
  });

  test('the label lands as a color: tag in RapidRAW vocabulary', async () => {
    const sandbox = await makeSandbox();
    try {
      await cli(sandbox, 'cull', sandbox.catalog, ...ALL_BLURRY, '--mark');
      await cli(sandbox, 'triage', 'apply', sandbox.catalog, '--editor', 'rapidraw');

      const written = JSON.parse(await readFile(rrdata(sandbox, '2026-08-02'), 'utf8'));
      expect(written.tags).toContain('color:red'); // lowercase, not Adobe's "Red"
      expect(written.version).toBe(1);
    } finally {
      await sandbox.dispose();
    }
  });

  test('a develop write into the same file keeps the marks it finds there', async () => {
    const sandbox = await makeSandbox();
    try {
      await cli(sandbox, 'cull', sandbox.catalog, ...ALL_BLURRY, '--mark');
      await cli(sandbox, 'triage', 'apply', sandbox.catalog, '--editor', 'rapidraw');

      const target = rrdata(sandbox, '2026-08-02');
      const { rapidrawAdapter } = await import('../src/develop/adapters/rapidraw/index.js');
      await rapidrawAdapter.writeEdit!(
        {
          develop: { Exposure2012: 0.35, Contrast2012: 12, Temperature: 6200 },
          treatment: 'color',
          asShot: { tempAsShot: 5200, tintAsShot: null, iso: 400, exposureComp: 0, camera: 'EOS R' },
        },
        target,
      );

      const written = JSON.parse(await readFile(target, 'utf8'));
      expect(written.adjustments.exposure).toBeCloseTo(0.35, 4);
      expect(written.adjustments.contrast).toBe(12);
      // 6200 K against a 5200 K capture is a warming, so the slider goes positive.
      expect(written.adjustments.temperature).toBeGreaterThan(0);
      // …and the label the cull recorded is still there.
      expect(written.tags).toContain('color:red');
    } finally {
      await sandbox.dispose();
    }
  });

  test('the marks survive in the other order too', async () => {
    const sandbox = await makeSandbox();
    try {
      const target = rrdata(sandbox, '2026-08-03');
      const { rapidrawAdapter } = await import('../src/develop/adapters/rapidraw/index.js');
      // Develop first, annotations after: `triage apply` must merge into the
      // prediction rather than template over it.
      await rapidrawAdapter.writeEdit!({ develop: { Contrast2012: 30 }, treatment: 'color' }, target);

      await cli(sandbox, 'cull', sandbox.catalog, ...ALL_BLURRY, '--mark');
      await cli(sandbox, 'triage', 'apply', sandbox.catalog, '--editor', 'rapidraw');

      const written = JSON.parse(await readFile(target, 'utf8'));
      expect(written.adjustments.contrast).toBe(30);
      expect(written.tags).toContain('color:red');
    } finally {
      await sandbox.dispose();
    }
  });

  test('a B&W prediction is refused rather than flattened to a desaturation', async () => {
    const sandbox = await makeSandbox();
    try {
      const { rapidrawAdapter } = await import('../src/develop/adapters/rapidraw/index.js');
      const attempt = rapidrawAdapter.writeEdit!(
        { develop: { Exposure2012: 0.2 }, treatment: 'bw' },
        rrdata(sandbox, '2026-08-02'),
      );
      expect(attempt).rejects.toThrow(/black-and-white/);
    } finally {
      await sandbox.dispose();
    }
  });
});

describe('triage clean', () => {
  xmpTest('drops what was applied and collects orphans', async () => {
    const sandbox = await makeSandbox();
    try {
      await cli(sandbox, 'cull', sandbox.catalog, ...ALL_BLURRY, '--mark');
      await cli(sandbox, 'triage', 'apply', sandbox.catalog);

      const { out } = await cli(sandbox, 'triage', 'clean');
      expect(out).toContain('dropped 2 applied');

      const list = await cli(sandbox, 'triage', 'list');
      expect(list.out).toContain('No triage marks');
    } finally {
      await sandbox.dispose();
    }
  });
});

describe('guards', () => {
  test('--copy without --dest is refused rather than silently ignored', async () => {
    const sandbox = await makeSandbox();
    try {
      const { code, err } = await cli(sandbox, 'cull', sandbox.catalog, '--mark', '--copy');
      expect(code).toBe(2);
      expect(err).toContain('--copy has no meaning without --dest');
    } finally {
      await sandbox.dispose();
    }
  });

  test('an invalid --mark-label names the valid ones', async () => {
    const sandbox = await makeSandbox();
    try {
      const { code, err } = await cli(sandbox, 'cull', sandbox.catalog, '--mark', '--mark-label', 'rosso');
      expect(code).toBe(2);
      expect(err).toContain('reject');
    } finally {
      await sandbox.dispose();
    }
  });

  test('a malformed label set fails before any sidecar is written', async () => {
    const sandbox = await makeSandbox();
    try {
      await cli(sandbox, 'cull', sandbox.catalog, ...ALL_BLURRY, '--mark');
      await Bun.write(path.join(sandbox.home, 'labels', 'acr.json'), '{ "rosso": "Red" }');

      const { code, err } = await cli(sandbox, 'triage', 'apply', sandbox.catalog);
      expect(code).toBe(2);
      expect(err).toContain("unknown label 'rosso'");
      expect(existsSync(sidecar(sandbox, '2026-08-02'))).toBe(false);
    } finally {
      await sandbox.dispose();
    }
  });
});
