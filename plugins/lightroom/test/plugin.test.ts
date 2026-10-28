/**
 * The Lightroom plug-in, tested without Lightroom: the pure modules under
 * fengari, every file for syntax, and the build that packages it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { buildPlugin, PLUGIN_FOLDER, SOURCE_DIR, stampInfoVersion } from '../build.js';
import { compileLuaFile, runLua } from './lua.js';

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

  test('builds the .lrplugin folder and a zip of it, version stamped', async () => {
    const dir = await out;
    const { folder, zip } = await buildPlugin(dir, '0.9.1');
    expect(path.basename(folder)).toBe(PLUGIN_FOLDER);
    expect(await readFile(path.join(folder, 'Info.lua'), 'utf8')).toContain("display = '0.9.1'");
    const entries = new AdmZip(zip).getEntries().map((e) => e.entryName.replace(/\\/g, '/'));
    expect(entries).toContain(`${PLUGIN_FOLDER}/Info.lua`);
    expect(entries).toContain(`${PLUGIN_FOLDER}/Json.lua`);
  });
});
