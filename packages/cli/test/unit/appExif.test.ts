import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { summarizeExif } from '../../src/app/exif.js';
import { Library } from '../../src/app/library.js';

const record = (tags: Record<string, unknown>) => ({ SourceFile: 'x', ...tags });

describe('summarizeExif', () => {
  test('a full record reads as a photographer would', () => {
    expect(
      summarizeExif(
        record({
          DateTimeOriginal: '2026:05:01 18:42:10',
          Make: 'SONY',
          Model: 'ILCE-7M3',
          LensID: 'FE 85mm F1.8',
          LensModel: 'ignored when LensID is there',
          ExposureTime: '1/250',
          FNumber: 2.8,
          ISO: 400,
          ExposureCompensation: '-1/3',
          FocalLength: '85.0 mm',
          FocalLengthIn35mmFormat: '85 mm',
          ExposureProgram: 'Aperture-priority AE',
          MeteringMode: 'Multi-segment',
          Flash: 'Off, Did not fire',
          WhiteBalance: 'Auto',
          ImageSize: '6000x4000',
          GPSLatitude: 41.8902,
          GPSLongitude: 12.4922,
        }),
      ),
    ).toEqual({
      taken: '2026-05-01 18:42:10',
      camera: 'SONY ILCE-7M3',
      lens: 'FE 85mm F1.8',
      exposure: '1/250 s · f/2.8 · ISO 400 · -1/3 EV',
      focalLength: '85 mm',
      mode: 'Aperture-priority AE · Multi-segment',
      flash: 'Off, Did not fire',
      whiteBalance: 'Auto',
      dimensions: '6000 × 4000',
      location: '41.89020, 12.49220',
    });
  });

  test('a model naming its maker is not repeated; crop focal lengths show both', () => {
    const s = summarizeExif(record({ Make: 'Canon', Model: 'Canon EOS R7', FocalLength: '35.0 mm', FocalLengthIn35mmFormat: '56 mm' }));
    expect(s.camera).toBe('Canon EOS R7');
    expect(s.focalLength).toBe('35 mm (56 mm full frame)');
  });

  test('zero compensation, unknown lenses and a 0,0 position are left out', () => {
    const s = summarizeExif(record({ ExposureCompensation: '0', ISO: 100, LensID: 'Unknown (00 0 0)', GPSLatitude: 0, GPSLongitude: 0 }));
    expect(s).toEqual({ exposure: 'ISO 100' });
  });

  test('an empty record is empty', () => {
    expect(summarizeExif(record({}))).toEqual({});
  });
});

describe('Library.exif', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shoots-exif-'));
  const file = path.join(dir, 'a.jpg');
  writeFileSync(file, 'x');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('reads once per file version', async () => {
    let reads = 0;
    const lib = new Library(async () => true, 600, 4, async () => (reads++, record({ ISO: 200 })));
    expect(await lib.exif(file)).toEqual({ exposure: 'ISO 200' });
    expect(await lib.exif(file)).toEqual({ exposure: 'ISO 200' });
    expect(reads).toBe(1);
  });

  test('without exiftool it says so', async () => {
    const lib = new Library(async () => false, 600, 4, async () => record({}));
    await expect(lib.exif(file)).rejects.toThrow(/exiftool/);
  });
});
