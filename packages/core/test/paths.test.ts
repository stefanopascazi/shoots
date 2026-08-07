/**
 * The `~/.shoots` layout.
 *
 * These read like tautologies until someone moves a directory: every path here
 * is a location on real users' disks, so a silent change to one of them
 * orphans whatever was already written there. The suite pins the layout.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import {
  binDir,
  cacheDir,
  configPath,
  developExportPath,
  developFeedbackPath,
  developHome,
  developProfilePath,
  developShootDir,
  developShootsDir,
  labelSetsDir,
  logsDir,
  matchDbPath,
  matchHome,
  modelDir,
  modelsDir,
  profilesDir,
  shootsHome,
  toolDir,
  triageHome,
  triageShootPath,
} from '../src/paths.js';

const HOME = path.resolve(path.join(os.tmpdir(), 'shoots-paths-test'));
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.SHOOTS_HOME;
  process.env.SHOOTS_HOME = HOME;
});

afterEach(() => {
  if (saved === undefined) delete process.env.SHOOTS_HOME;
  else process.env.SHOOTS_HOME = saved;
});

describe('shootsHome', () => {
  test('honours SHOOTS_HOME, resolved to an absolute path', () => {
    expect(shootsHome()).toBe(HOME);
    process.env.SHOOTS_HOME = 'relative-home';
    expect(shootsHome()).toBe(path.resolve('relative-home'));
  });

  test('falls back to ~/.shoots when the override is unset or empty', () => {
    const fallback = path.join(os.homedir(), '.shoots');
    delete process.env.SHOOTS_HOME;
    expect(shootsHome()).toBe(fallback);
    process.env.SHOOTS_HOME = '';
    expect(shootsHome()).toBe(fallback);
  });
});

describe('the well-known subfolders', () => {
  test('all hang off the home directory', () => {
    expect(binDir()).toBe(path.join(HOME, 'bin'));
    expect(modelsDir()).toBe(path.join(HOME, 'models'));
    expect(cacheDir()).toBe(path.join(HOME, 'cache'));
    expect(profilesDir()).toBe(path.join(HOME, 'profiles'));
    expect(developHome()).toBe(path.join(HOME, 'develop'));
    expect(triageHome()).toBe(path.join(HOME, 'triage'));
    expect(labelSetsDir()).toBe(path.join(HOME, 'labels'));
    expect(matchHome()).toBe(path.join(HOME, 'match'));
    expect(logsDir()).toBe(path.join(HOME, 'logs'));
    expect(configPath()).toBe(path.join(HOME, 'config.json'));
  });

  test('tools and models are versioned one directory deep', () => {
    expect(toolDir('exiftool', '13.10')).toBe(path.join(HOME, 'bin', 'exiftool', '13.10'));
    expect(modelDir('clip', 'int8-2')).toBe(path.join(HOME, 'models', 'clip', 'int8-2'));
  });

  test('the develop artifacts keep feedback outside the disposable export tree', () => {
    expect(developExportPath()).toBe(path.join(HOME, 'develop', 'export', 'export.jsonl'));
    expect(developProfilePath()).toBe(path.join(HOME, 'develop', 'profile', 'export.json'));
    expect(developShootsDir()).toBe(path.join(HOME, 'develop', 'export', 'shooting'));
    expect(developShootDir('2026-08-02')).toBe(path.join(HOME, 'develop', 'export', 'shooting', '2026-08-02'));

    // The one develop artifact `develop clean` must not be able to drop.
    expect(developFeedbackPath()).toBe(path.join(HOME, 'develop', 'feedback.jsonl'));
    expect(developFeedbackPath().startsWith(path.join(HOME, 'develop', 'export'))).toBe(false);
  });

  test('triage marks and duel databases are named after what they describe', () => {
    expect(triageShootPath('2026-08-02')).toBe(path.join(HOME, 'triage', '2026-08-02.jsonl'));
    expect(matchDbPath('street')).toBe(path.join(HOME, 'match', 'street.db'));
  });

  test('nothing is written beside the photographs', () => {
    for (const p of [triageHome(), developHome(), cacheDir(), matchHome()]) {
      expect(p.startsWith(HOME)).toBe(true);
    }
  });
});
