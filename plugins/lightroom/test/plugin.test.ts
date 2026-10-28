/**
 * The Lightroom plug-in, tested without Lightroom: the pure modules under
 * fengari, every file for syntax, and the build that packages it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { buildPlugin, PLUGIN_FOLDER, SOURCE_DIR, stampInfoVersion, stampPluginVersion } from '../build.js';
import { compileLuaFile, runLua } from './lua.js';
import { catalogAdapter } from '../../../packages/cli/src/develop/adapters/lightroom/index.js';
import { parseCatalogExport } from '../../../packages/cli/src/develop/adapters/lightroom/catalog.js';
import { inspectCatalogExport } from '../../../packages/cli/src/develop/adapters/lightroom/inspect.js';

describe('Json.decode', () => {
  test('decodes a cull report as the CLI prints it', () => {
    const report = { command: 'cull', results: [{ file: 'C:\\a b\\x.CR3', score: 12.5, verdict: 'blurry', rescued: false }], errors: [] };
    const out = runLua(`return require('Json').decode(${JSON.stringify(JSON.stringify(report, null, 2))})`);
    expect(out).toEqual(report);
  });

  test('handles escapes, unicode and surrogate pairs', () => {
    const text = JSON.stringify({ s: 'a"b\\c\n\u00e8\u{1F4F7}' });
    expect(runLua(`return require('Json').decode(${JSON.stringify(text)})`)).toEqual({ s: 'a"b\\c\nè📷' });
  });

  test('numbers, booleans and null', () => {
    expect(runLua(`return require('Json').decode('[-1.5e2, 0, true, false, null]')`)).toEqual([-150, 0, true, false, null]);
  });

  test('malformed input raises', () => {
    expect(() => runLua(`return require('Json').decode('{"a": }')`)).toThrow(/invalid JSON/);
    expect(() => runLua(`return require('Json').decode('[1] x')`)).toThrow(/trailing/);
  });
});

describe('Command.build', () => {
  test('posix quotes every argument, including single quotes', () => {
    const line = runLua<string>(`return require('Command').build('posix', '/Users/me/.shoots/bin/shoots', { 'rate', "it's" }, '/tmp/o', '/tmp/e')`);
    expect(line).toBe(`'/Users/me/.shoots/bin/shoots' 'rate' 'it'\\''s' > '/tmp/o' 2> '/tmp/e'`);
  });

  test('windows wraps the whole line once more for cmd.exe', () => {
    const line = runLua<string>(`return require('Command').build('windows', 'C:\\\\Users\\\\me\\\\shoots.exe', { 'cull', '--json' }, 'C:\\\\t\\\\o', 'C:\\\\t\\\\e')`);
    expect(line).toBe(`""C:\\Users\\me\\shoots.exe" "cull" "--json" > "C:\\t\\o" 2> "C:\\t\\e""`);
  });

  test('rate never writes sidecars; cull never moves or marks', () => {
    expect(runLua(`return require('Command').rateArgs('/l.txt', 'wedding')`)).toEqual(['rate', '--files-from', '/l.txt', '--profile', 'wedding', '--dry-run', '--json']);
    expect(runLua(`return require('Command').cullArgs('/l.txt')`)).toEqual(['cull', '--files-from', '/l.txt', '--json']);
  });
});

describe('the app server launch', () => {
  test('windows starts it in the background with start /B, output to a log', () => {
    const line = runLua<string>(
      `local C = require('Command') return C.detachedLine('windows', 'C:\\\\s\\\\shoots.exe', C.appArgs(), 'C:\\\\t\\\\app.log')`,
    );
    expect(line).toBe(`start "" /B "C:\\s\\shoots.exe" "app" > "C:\\t\\app.log" 2>&1`);
  });

  test('posix detaches with nohup and &', () => {
    const line = runLua<string>(`local C = require('Command') return C.detachedLine('posix', '/s/shoots', C.appArgs(), '/t/app.log')`);
    expect(line).toBe(`nohup '/s/shoots' 'app' > '/t/app.log' 2>&1 &`);
  });
});

describe('AppSession', () => {
  const session = { pid: 7, port: 55552, token: 'tok', url: 'http://127.0.0.1:55552/?t=tok', startedAt: 'a' };

  test('parses the file the server writes', () => {
    expect(runLua(`return require('AppSession').parse(${JSON.stringify(JSON.stringify(session, null, 2))})`)).toEqual(session);
  });

  test('missing, torn or foreign files are not a session', () => {
    expect(runLua(`return require('AppSession').parse('')`)).toBeNull();
    expect(runLua(`return require('AppSession').parse('{"port": 1, "tok')`)).toBeNull();
    expect(runLua(`return require('AppSession').parse('{"port": "1"}')`)).toBeNull();
  });

  test('endpoints are on loopback, headers carry the token', () => {
    const s = `require('Json').decode(${JSON.stringify(JSON.stringify(session))})`;
    expect(runLua(`return require('AppSession').endpoint(${s}, '/api/host/heartbeat')`)).toBe('http://127.0.0.1:55552/api/host/heartbeat');
    expect(runLua(`return require('AppSession').headers(${s})`)).toEqual([
      { field: 'x-shoots-token', value: 'tok' },
      { field: 'Content-Type', value: 'application/json' },
    ]);
  });

  test('a restarted server counts as new', () => {
    const A = `{ pid = 1, startedAt = 'a' }`;
    expect(runLua(`return require('AppSession').isNew(nil, ${A})`)).toBe(true);
    expect(runLua(`return require('AppSession').isNew(${A}, { pid = 1, startedAt = 'a' })`)).toBe(false);
    expect(runLua(`return require('AppSession').isNew(${A}, { pid = 2, startedAt = 'b' })`)).toBe(true);
    expect(runLua(`return require('AppSession').isNew(${A}, nil)`)).toBe(false);
  });
});

describe('Outbox', () => {
  test('reads the pending count off the heartbeat, 0 on anything else', () => {
    expect(runLua(`return require('Outbox').pendingCount('{"ok":true,"pending":3}')`)).toBe(3);
    expect(runLua(`return require('Outbox').pendingCount('{"ok":true}')`)).toBe(0);
    expect(runLua(`return require('Outbox').pendingCount('nope')`)).toBe(0);
    expect(runLua(`return require('Outbox').pendingCount(nil)`)).toBe(0);
  });

  test('keeps only well-formed items', () => {
    const body = JSON.stringify({ items: [{ id: 1, path: 'C:\\a.CR3', rating: 4, pick: -1 }, { id: 'x' }, { path: 'p' }] });
    expect(runLua(`return require('Outbox').items(${JSON.stringify(body)})`)).toEqual([{ id: 1, path: 'C:\\a.CR3', rating: 4, pick: -1 }]);
    expect(runLua(`return require('Outbox').items('{}')`)).toEqual([]);
  });

  test('maps a change to catalog fields and leaves nulls alone', () => {
    const fields = (item: string) => runLua(`return require('Outbox').fields(require('Json').decode(${JSON.stringify(item)}))`);
    expect(fields('{"rating":4,"pick":-1}')).toEqual({ rating: 4, pickStatus: -1 });
    expect(fields('{"rating":null,"pick":0}')).toEqual({ pickStatus: 0 });
    expect(fields('{"rating":9,"pick":7}')).toEqual({ rating: 5 });
    expect(fields('{"label":"green"}')).toEqual({ colorNameForLabel: 'green' });
    expect(fields('{"label":"none"}')).toEqual({ colorNameForLabel: 'none' });
    // An unknown label sets nothing (an empty Lua table reads back as []).
    expect(fields('{"label":"pink"}')).toEqual([]);
  });

  test('the acknowledgement lists applied and missing ids', () => {
    expect(runLua(`return require('Outbox').ackBody({ 1, 2 }, {})`)).toBe('{"applied":[1,2],"missing":[]}');
    expect(JSON.parse(runLua<string>(`return require('Outbox').ackBody({}, { 7 })`))).toEqual({ applied: [], missing: [7] });
  });
});

describe('CatalogExport', () => {
  test('reads the training to export for off the heartbeat', () => {
    const reply = JSON.stringify({ ok: true, export: { job: 'job-abc-12', folder: 'C:\\Shoot', recursive: true } });
    expect(runLua(`return require('CatalogExport').request(${JSON.stringify(reply)})`)).toEqual({ job: 'job-abc-12', folder: 'C:\\Shoot', recursive: true, raw: false });
    expect(runLua(`return require('CatalogExport').request('{"export":{"job":"j","folder":"f","raw":true}}')`)).toMatchObject({ raw: true });
    expect(runLua(`return require('CatalogExport').request('{"ok":true,"export":null}')`)).toBeNull();
    // The id goes into a URL: anything but a plain id is refused.
    expect(runLua(`return require('CatalogExport').request('{"export":{"job":"a&b","folder":"x"}}')`)).toBeNull();
    expect(runLua(`return require('CatalogExport').request('nope')`)).toBeNull();
  });

  test('keeps scalars, the tone curve and the look name; drops masks', () => {
    const out = runLua(`return require('CatalogExport').settings({
      Exposure2012 = 0.35, WhiteBalance = 'Custom', ConvertToGrayscale = false,
      ToneCurvePV2012 = { 0, 0, 128, 140, 255, 255 },
      Look = { Name = 'Adobe Color', Amount = 1 },
      MaskGroupBasedCorrections = { { What = 'Mask' } },
    })`);
    expect(out).toEqual({
      Exposure2012: 0.35,
      WhiteBalance: 'Custom',
      ConvertToGrayscale: false,
      ToneCurvePV2012: [0, 0, 128, 140, 255, 255],
      LookName: 'Adobe Color',
    });
  });

  test('the body is what the engine reads, edit for edit', async () => {
    const body = runLua<string>(`local C = require('CatalogExport')
      return C.body('C:\\\\Shoot', {
        { path = 'C:\\\\Shoot\\\\a "1".CR3', settings = C.settings({
          Exposure2012 = -0.5, Temperature = 5600, WhiteBalance = 'Custom', ConvertToGrayscale = false,
          Contrast2012 = 12, ToneCurvePV2012 = { 0, 0, 255, 255 }, CameraProfile = 'Adobe Standard',
        }) },
        { path = 'C:\\\\Shoot\\\\b.CR3', settings = C.settings({ Exposure2012 = 0, WhiteBalance = 'As Shot' }) },
      })`);
    const data = parseCatalogExport(body);
    expect(data.folder).toBe('C:\\Shoot');
    expect(data.photos.map((p) => p.path)).toEqual(['C:\\Shoot\\a "1".CR3', 'C:\\Shoot\\b.CR3']);

    const files = data.photos.map((p) => p.path);
    const edits = await catalogAdapter(data).readEdits(files, { json: true, verbose: false });
    const a = edits.get(files[0])!;
    expect(a.develop).toMatchObject({ Exposure2012: -0.5, Temperature: 5600, Contrast2012: 12, ConvertToGrayscale: 0 });
    expect(a.edited).toBe(true);
    expect(a.treatment).toBe('color');
    expect(a.baseProfile).toBe('Adobe Standard');
    // Lightroom's neutral settings on an untouched photo are not an edit.
    expect(edits.get(files[1])?.edited ?? false).toBe(false);
  });
});

describe('yielding inside Lightroom', () => {
  // Lua 5.1 cannot yield through a plain pcall, and LrHttp and catalog writes
  // always yield: such a pcall fails at once and hides why. It cost every
  // step of the lease loop. Only pure decoding may use a plain pcall.
  test('every pcall around Lightroom calls is LrTasks.pcall', async () => {
    const offenders: string[] = [];
    for (const name of (await readdir(SOURCE_DIR)).filter((f) => f.endsWith('.lua'))) {
      const lines = (await readFile(path.join(SOURCE_DIR, name), 'utf8')).split('\n');
      lines.forEach((line, i) => {
        if (/^\s*--/.test(line)) return;
        for (const m of line.matchAll(/(LrTasks\.)?pcall\(\s*([\w.]+)?/g)) {
          if (!m[1] && m[2] !== 'Json.decode') offenders.push(`${name}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('HostError', () => {
  test('a failure travels as JSON, quoted and capped', () => {
    const body = runLua<string>(`return require('HostError').body('send to Lightroom', 'AppOutbox.lua:51: "boom"\\nnext')`);
    expect(JSON.parse(body)).toEqual({ where: 'send to Lightroom', message: 'AppOutbox.lua:51: "boom"\nnext' });
    const long = JSON.parse(runLua<string>(`return require('HostError').body('x', string.rep('a', 900))`));
    expect(long.message.length).toBeLessThan(510);
  });
});

describe('CatalogExport, folders', () => {
  test('progress is reported on its own route', () => {
    expect(runLua(`return require('CatalogExport').progressRoute('job-1', 50, 380)`)).toBe('/api/catalog/progress?job=job-1&done=50&total=380');
  });

  test('a folder path loses its trailing separator, except at a drive root', () => {
    const p = (folder: string) => runLua(`return require('CatalogExport').folderPath(${JSON.stringify(folder)})`);
    expect(p('\\\\NAS\\Photos\\')).toBe('\\\\NAS\\Photos');
    expect(p('\\\\NAS\\Photos\\2025')).toBe('\\\\NAS\\Photos\\2025');
    expect(p('C:\\')).toBe('C:\\');
    expect(p('/Volumes/Photos/')).toBe('/Volumes/Photos');
    expect(p('/')).toBe('/');
  });

  test('the heartbeat request is normalised the same way', () => {
    const reply = JSON.stringify({ export: { job: 'j', folder: '\\\\NAS\\Photos\\', recursive: false } });
    expect(runLua(`return require('CatalogExport').request(${JSON.stringify(reply)}).folder`)).toBe('\\\\NAS\\Photos');
  });

  test('a folder the catalog lacks is said, not sent empty', () => {
    const body = runLua<string>(`return require('CatalogExport').notFound(${JSON.stringify('\\\\NAS\\Photos')})`);
    expect(parseCatalogExport(body)).toMatchObject({ folder: '\\\\NAS\\Photos', found: false, photos: [] });
  });
});

describe('CatalogExport, export only', () => {
  test('raw settings travel as they are: nested tables, lists, odd values', () => {
    const text = runLua<string>(`return require('CatalogExport').encodeRaw({
      Exposure2012 = 0.5, Look = { Name = 'Adobe Color', Parameters = { Version = 2 } },
      ToneCurvePV2012 = { 0, 0, 255, 255 }, Sparse = { [1] = 'a', [3] = 'c' }, Fn = function() end,
    })`);
    expect(JSON.parse(text)).toEqual({
      Exposure2012: 0.5,
      Fn: '<function>',
      Look: { Name: 'Adobe Color', Parameters: { Version: 2 } },
      Sparse: { '1': 'a', '3': 'c' },
      ToneCurvePV2012: [0, 0, 255, 255],
    });
  });

  test('the engine reports the shapes and the names that did not match', async () => {
    const body = runLua<string>(`local C = require('CatalogExport')
      local raw = { Exposure = 0.3, Contrast2012 = 10, WhiteBalance = 'Custom',
        ToneCurvePV2012 = { 0, 0, 255, 255 }, Look = { Name = 'Adobe Color', UUID = 'x' } }
      return C.body('/s', { { path = '/s/a.cr3', settings = C.settings(raw), raw = raw } })`);
    const report = await inspectCatalogExport(body, 'kept.json');
    expect(report).toMatchObject({ photos: 1, withSettings: 1, edited: 1, raw: true });
    expect(report.shapes).toEqual({ ToneCurvePV2012: 'array of 4 numbers', Look: 'object: Name, UUID' });
    // A key named differently from the crs property is unknown, and its target missing.
    expect(report.unknown).toContain('Exposure');
    expect(report.missing).toContain('Exposure2012');
    expect(report.missing).not.toContain('Contrast2012');
  });
});

describe('Sync', () => {
  test('reads the folder to follow off the heartbeat', () => {
    expect(runLua(`return require('Sync').watch('{"ok":true,"watch":{"folder":"C:\\\\\\\\Shoot","recursive":true}}')`)).toEqual({ folder: 'C:\\Shoot', recursive: true });
    expect(runLua(`return require('Sync').watch('{"ok":true,"watch":null}')`)).toBeNull();
    expect(runLua(`return require('Sync').watch('nope')`)).toBeNull();
  });

  test('normalizes catalog values: no rating is 0, no label is none', () => {
    expect(runLua(`return require('Sync').normalize({ rating = 3, pickStatus = -1, colorNameForLabel = 'red' })`)).toEqual({ rating: 3, pick: -1, label: 'red' });
    expect(runLua(`return require('Sync').normalize({})`)).toEqual({ rating: 0, pick: 0, label: 'none' });
    expect(runLua(`return require('Sync').normalize({ rating = 9, pickStatus = 5, colorNameForLabel = 'grey' })`)).toEqual({ rating: 5, pick: 0, label: 'none' });
  });

  test('a first read reports everything; later reads only what changed', () => {
    const current = `{ ['/b'] = { rating = 1, pick = 0, label = 'none' }, ['/a'] = { rating = 3, pick = 1, label = 'red' } }`;
    expect(runLua(`return require('Sync').diff(nil, ${current})`)).toEqual([
      { path: '/a', rating: 3, pick: 1, label: 'red' },
      { path: '/b', rating: 1, pick: 0, label: 'none' },
    ]);
    const previous = `{ ['/b'] = { rating = 1, pick = 0, label = 'none' }, ['/a'] = { rating = 2, pick = 1, label = 'red' } }`;
    expect(runLua(`return require('Sync').diff(${previous}, ${current})`)).toEqual([{ path: '/a', rating: 3, pick: 1, label: 'red' }]);
  });

  test('the report is JSON, with paths escaped', () => {
    const body = runLua<string>(`return require('Sync').report('C:\\\\Shoot "x"', { { path = 'C:\\\\Shoot\\\\a.CR3', rating = 3, pick = -1, label = 'red' } })`);
    expect(JSON.parse(body)).toEqual({ folder: 'C:\\Shoot "x"', photos: [{ path: 'C:\\Shoot\\a.CR3', rating: 3, pick: -1, label: 'red' }] });
  });
});

describe('Command env and installer', () => {
  test('env goes in front, sorted, quoted per platform', () => {
    const posix = runLua<string>(`return require('Command').build('posix', '/s', { '--version' }, '/o', '/e', { SHOOTS_PROGRESS_FILE = "/t/p q.jsonl", A = 'x' })`);
    expect(posix).toBe(`A='x' SHOOTS_PROGRESS_FILE='/t/p q.jsonl' '/s' '--version' > '/o' 2> '/e'`);
    const win = runLua<string>(`return require('Command').build('windows', 'C:\\\\s.exe', { '--version' }, 'C:\\\\o', 'C:\\\\e', { SHOOTS_PROGRESS_FILE = 'C:\\\\p.jsonl' })`);
    expect(win).toBe(`"set "SHOOTS_PROGRESS_FILE=C:\\p.jsonl" && "C:\\s.exe" "--version" > "C:\\o" 2> "C:\\e""`);
  });

  test('the installer line runs the published install script', () => {
    const win = runLua<string>(`return require('Command').installLine('windows', 'C:\\\\o', 'C:\\\\e', { SHOOTS_INSTALL_DIR = 'C:\\\\bin' })`);
    expect(win).toBe(
      `"set "SHOOTS_INSTALL_DIR=C:\\bin" && powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://www.shoots-ai.com/install.ps1 | iex" > "C:\\o" 2> "C:\\e""`,
    );
    const posix = runLua<string>(`return require('Command').installLine('posix', '/o', '/e')`);
    expect(posix).toBe(`/bin/bash -c 'curl -fsSL https://www.shoots-ai.com/install.sh | bash' > '/o' 2> '/e'`);
  });

  test('update and setup speak --json', () => {
    expect(runLua(`return require('Command').updateArgs()`)).toEqual(['update', '--json']);
    expect(runLua(`return require('Command').setupArgs()`)).toEqual(['setup', '--json']);
  });
});

describe('Progress.parse', () => {
  const parse = (text: string) => runLua(`return require('Progress').parse(${JSON.stringify(text)})`);

  test('nothing yet', () => {
    expect(parse('')).toBeNull();
  });

  test('steps give a fraction and a counted caption', () => {
    const text = '{"kind":"phase","label":"Scanning"}\n{"kind":"steps","label":"Rating","done":3,"total":12,"detail":"a.jpg"}\n';
    expect(parse(text)).toEqual({ fraction: 0.25, caption: 'Rating 3/12 - a.jpg' });
  });

  test('a half-written last line falls back to the one before', () => {
    expect(parse('{"kind":"phase","label":"Loading model"}\n{"kind":"steps","lab')).toEqual({ caption: 'Loading model' });
  });

  test('downloads read in megabytes, indeterminate without a size', () => {
    expect(parse('{"kind":"download","label":"exiftool","received":1048576,"total":4194304}')).toEqual({
      fraction: 0.25,
      caption: 'exiftool - 1.0 MB of 4.0 MB',
    });
    expect(parse('{"kind":"download","label":"model","received":2097152,"total":null}')).toEqual({ caption: 'model - 2.0 MB' });
  });
});

describe('Version', () => {
  const satisfies = (installed: string | null, required: string) =>
    runLua<boolean>(`return require('Version').satisfies(${installed === null ? 'nil' : JSON.stringify(installed)}, ${JSON.stringify(required)})`);

  test('a development plug-in accepts any CLI', () => {
    expect(satisfies(null, '0.0.0')).toBe(true);
  });

  test('compares by release, ignoring pre-release tags and prefixes', () => {
    expect(satisfies('0.8.0', '0.8.0')).toBe(true);
    expect(satisfies('shoots 0.10.1\n', '0.8.0')).toBe(true);
    expect(satisfies('0.7.3', '0.8.0')).toBe(false);
    expect(satisfies('0.8.0-beta.1', '0.8.0')).toBe(true);
  });

  test('an unreadable installed version is too old', () => {
    expect(satisfies(null, '0.8.0')).toBe(false);
    expect(satisfies('garbage', '0.8.0')).toBe(false);
  });
});

describe('Results', () => {
  test('pathKey folds case and separators on windows only', () => {
    expect(runLua(`return require('Results').pathKey('C:/Shoot/A.CR3', 'windows')`)).toBe('c:\\shoot\\a.cr3');
    expect(runLua(`return require('Results').pathKey('/Shoot/A.CR3', 'posix')`)).toBe('/Shoot/A.CR3');
  });

  test('cull rejects only blurry frames', () => {
    const out = runLua(`
      local changes, counts = require('Results').cullChanges({
        results = { { file = '/a.jpg', verdict = 'blurry' }, { file = '/b.jpg', verdict = 'sharp' } },
        errors = { { file = '/c.jpg', error = 'file not found' } },
      }, 'posix')
      return { changes = changes, counts = counts }`);
    expect(out).toEqual({ changes: { '/a.jpg': { pickStatus: -1 } }, counts: { rejected: 1, kept: 1, failed: 1 } });
  });

  test('rate clamps to 0..5 and skips results without stars', () => {
    const out = runLua(`
      local changes, counts = require('Results').rateChanges({
        results = { { file = '/a.jpg', stars = 7 }, { file = '/b.jpg', stars = 2.6 }, { file = '/c.jpg' } },
      }, 'posix')
      return { changes = changes, counts = counts }`);
    expect(out).toEqual({ changes: { '/a.jpg': { rating: 5 }, '/b.jpg': { rating: 3 } }, counts: { rated: 2, failed: 0 } });
  });

  test('summary names failures only when there are some', () => {
    expect(runLua(`return require('Results').summary('cull', { rejected = 2, kept = 5, failed = 0 })`)).toBe('2 rejected as blurry, 5 kept.');
    expect(runLua(`return require('Results').summary('rate', { rated = 4, failed = 1 })`)).toBe('4 rated, 1 failed.');
  });
});

describe('plug-in files', () => {
  test('every Lua file compiles', async () => {
    const files = (await readdir(SOURCE_DIR)).filter((f) => f.endsWith('.lua'));
    expect(files).toContain('Info.lua');
    for (const f of files) expect([f, compileLuaFile(f)]).toEqual([f, null]);
  });

  test('every menu item points at a file that exists', async () => {
    const info = await readFile(path.join(SOURCE_DIR, 'Info.lua'), 'utf8');
    const files = new Set(await readdir(SOURCE_DIR));
    const referenced = [...info.matchAll(/file = '([^']+)'/g)].map((m) => m[1]!);
    expect(referenced.length).toBeGreaterThan(0);
    for (const f of referenced) expect(files.has(f)).toBe(true);
    expect(files.has(/LrPluginInfoProvider = '([^']+)'/.exec(info)![1]!)).toBe(true);
  });
});

describe('build', () => {
  const out = mkdtemp(path.join(tmpdir(), 'shoots-lrplugin-'));
  afterAll(async () => rm(await out, { recursive: true, force: true }));

  test('stampInfoVersion writes the release version', () => {
    const stamped = stampInfoVersion("VERSION = { major = 0, minor = 0, revision = 0, display = '0.0.0' },", '1.2.3-beta.1');
    expect(stamped).toBe("VERSION = { major = 1, minor = 2, revision = 3, display = '1.2.3-beta.1' },");
    expect(() => stampInfoVersion('return {}', '1.2.3')).toThrow(/no VERSION/);
    expect(() => stampInfoVersion('VERSION = {}', 'v1')).toThrow(/not a release/);
  });

  test('stampPluginVersion writes the version the CLI must meet', () => {
    expect(stampPluginVersion("-- c\nreturn '0.0.0'\n", '0.8.0')).toBe("-- c\nreturn '0.8.0'\n");
    expect(() => stampPluginVersion('return 1', '0.8.0')).toThrow(/no version/);
  });

  test('builds the .lrplugin folder and a zip of it, version stamped', async () => {
    const dir = await out;
    const { folder, zip } = await buildPlugin(dir, '0.9.1');
    expect(path.basename(folder)).toBe(PLUGIN_FOLDER);
    expect(await readFile(path.join(folder, 'Info.lua'), 'utf8')).toContain("display = '0.9.1'");
    expect(await readFile(path.join(folder, 'PluginVersion.lua'), 'utf8')).toContain("return '0.9.1'");
    const entries = new AdmZip(zip).getEntries().map((e) => e.entryName.replace(/\\/g, '/'));
    expect(entries).toContain(`${PLUGIN_FOLDER}/Info.lua`);
    expect(entries).toContain(`${PLUGIN_FOLDER}/Json.lua`);
  });
});
