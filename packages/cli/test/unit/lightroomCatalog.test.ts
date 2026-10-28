import { describe, expect, test } from 'bun:test';
import { catalogIndex, parseCatalogExport, toCrsRecord } from '../../src/develop/adapters/lightroom/catalog.js';
import { catalogAdapter } from '../../src/develop/adapters/lightroom/index.js';
import { readAsShot } from '../../src/develop/adapters/acr/ingest.js';

const io = { json: true, verbose: false };

describe('parseCatalogExport', () => {
  test('keeps well-formed photos', () => {
    const data = parseCatalogExport(
      JSON.stringify({ version: 1, folder: '/s', photos: [{ path: '/s/a.cr3', settings: { Exposure2012: 1 } }, { path: 3 }, null] }),
    );
    expect(data).toEqual({ version: 1, folder: '/s', found: true, roots: [], photos: [{ path: '/s/a.cr3', settings: { Exposure2012: 1 } }] });
  });

  test('refuses what it cannot read, naming the version', () => {
    expect(() => parseCatalogExport('nope')).toThrow('not valid JSON');
    expect(() => parseCatalogExport('{"version":1}')).toThrow('no photos');
    expect(() => parseCatalogExport('{"version":2,"photos":[]}')).toThrow('version 2');
  });
});

describe('toCrsRecord', () => {
  test("speaks exiftool's names: Temperature becomes ColorTemperature, the curve a list", () => {
    expect(toCrsRecord('/a', { Temperature: 5200, ToneCurvePV2012: [0, 0, 255, 255], WhiteBalance: 'Custom' })).toEqual({
      SourceFile: '/a',
      ColorTemperature: 5200,
      ToneCurvePV2012: '0, 0, 255, 255',
      WhiteBalance: 'Custom',
    });
  });

  test('the as-shot anchor reads the chosen white balance from it', () => {
    const crs = toCrsRecord('/a', { Temperature: 5200, WhiteBalance: 'Custom' });
    expect(readAsShot(crs, { SourceFile: '/a', ColorTempAsShot: 4800 }).tempAsShot).toBe(4800);
    const asShot = toCrsRecord('/a', { Temperature: 5200, WhiteBalance: 'As Shot' });
    expect(readAsShot(asShot, { SourceFile: '/a', ColorTempAsShot: 4800 }).tempAsShot).toBe(5200);
  });
});

describe('catalogIndex', () => {
  const data = parseCatalogExport(JSON.stringify({ version: 1, folder: '', photos: [{ path: 'C:/Shoot/A.CR3', settings: {} }] }));

  test('network share paths match as Lightroom spells them', () => {
    const share = parseCatalogExport(
      JSON.stringify({ version: 1, folder: '', photos: [{ path: '\\\\NAS\\Photos\\2025\\A.CR3', settings: {} }] }),
    );
    expect(catalogIndex(share, true)('\\\\nas\\photos\\2025\\a.cr3')).toBeDefined();
  });

  test('an export says whether the catalog had the folder', () => {
    expect(parseCatalogExport('{"version":1,"photos":[]}').found).toBe(true);
    expect(parseCatalogExport('{"version":1,"found":false,"photos":[]}').found).toBe(false);
  });

  test('matches case-insensitively where the file system does', () => {
    expect(catalogIndex(data, true)('c:/shoot/a.cr3')).toBeDefined();
    expect(catalogIndex(data, false)('c:/shoot/a.cr3')).toBeUndefined();
  });
});

describe('catalogAdapter', () => {
  test('reads edits from the export only, and treats B&W as such', async () => {
    const data = parseCatalogExport(
      JSON.stringify({
        version: 1,
        folder: '/s',
        photos: [
          { path: '/s/bw.cr3', settings: { ConvertToGrayscale: true, GrayMixerRed: -20, Contrast2012: 10 } },
          { path: '/s/look.cr3', settings: { Exposure2012: 0.3, CameraProfile: 'Adobe Standard v2', LookName: 'Adobe Color' } },
        ],
      }),
    );
    const adapter = catalogAdapter(data);
    expect(adapter.ingestOnly).toBe(true);
    const edits = await adapter.readEdits(['/s/bw.cr3', '/s/look.cr3', '/s/other.cr3'], io);
    expect(edits.get('/s/bw.cr3')).toMatchObject({ treatment: 'bw', edited: true });
    expect(edits.get('/s/look.cr3')).toMatchObject({ edited: true, baseProfile: 'Adobe Standard v2', look: 'Adobe Color' });
    expect(edits.has('/s/other.cr3')).toBe(false);
  });
});
