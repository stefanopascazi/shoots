/**
 * The interactive shell's command catalog and its autocomplete.
 *
 * `assertShellCatalogInSync` is the convention "every CLI command also lives in
 * the shell", enforced at startup — so its own failure modes are worth pinning:
 * a command that drifts out of the catalog must fail loudly with a diff, not
 * vanish silently from `/` completion.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertShellCatalogInSync,
  COMMANDS,
  findCliCommand,
  findCommand,
} from '../../src/shell/catalog.js';
import { getSuggestions } from '../../src/shell/suggestions.js';

const programWith = (names: string[]): Command => {
  const program = new Command();
  for (const name of names) program.command(name);
  return program;
};

const CLI_COMMANDS = COMMANDS.filter((c) => !c.builtin).map((c) => c.name);

describe('COMMANDS', () => {
  test('names each command once', () => {
    expect(new Set(COMMANDS.map((c) => c.name)).size).toBe(COMMANDS.length);
  });

  test('gives every entry a summary and a usage line', () => {
    for (const c of COMMANDS) {
      expect(c.summary.length).toBeGreaterThan(0);
      expect(c.usage.startsWith(`/${c.name}`)).toBe(true);
    }
  });
});

describe('findCommand / findCliCommand', () => {
  test('finds a spawnable command either way', () => {
    expect(findCommand('cull')!.name).toBe('cull');
    expect(findCliCommand('cull')!.name).toBe('cull');
  });

  test('refuses to hand a builtin to the spawner', () => {
    expect(findCommand('cd')!.builtin).toBe(true);
    expect(findCliCommand('cd')).toBeUndefined();
  });

  test('is undefined for a name nobody defines', () => {
    expect(findCommand('nope')).toBeUndefined();
    expect(findCliCommand('')).toBeUndefined();
  });
});

describe('assertShellCatalogInSync', () => {
  test('accepts a program registering exactly the catalog', () => {
    expect(() => assertShellCatalogInSync(programWith(CLI_COMMANDS))).not.toThrow();
  });

  test('ignores the commands that deliberately have no catalog entry', () => {
    expect(() => assertShellCatalogInSync(programWith([...CLI_COMMANDS, 'shell', 'help']))).not.toThrow();
  });

  test('names a CLI command missing from the shell, and where to add it', () => {
    const program = programWith([...CLI_COMMANDS, 'brand-new']);
    expect(() => assertShellCatalogInSync(program)).toThrow(/missing from the shell catalog/);
    expect(() => assertShellCatalogInSync(program)).toThrow(/brand-new/);
  });

  test('names a catalog entry the CLI does not register', () => {
    const program = programWith(CLI_COMMANDS.filter((n) => n !== 'cull'));
    expect(() => assertShellCatalogInSync(program)).toThrow(/not registered on the CLI/);
    expect(() => assertShellCatalogInSync(program)).toThrow(/cull/);
  });

  test('reports both directions of drift in one message', () => {
    const program = programWith([...CLI_COMMANDS.filter((n) => n !== 'cull'), 'brand-new']);
    try {
      assertShellCatalogInSync(program);
      throw new Error('expected the catalog check to fail');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/missing from the shell catalog/);
      expect(message).toMatch(/not registered on the CLI/);
    }
  });
});

describe('getSuggestions, in command mode', () => {
  test('completes a slash prefix to every matching command', async () => {
    const { items } = await getSuggestions('/cu', process.cwd());
    expect(items.map((i) => i.label)).toEqual(['/cull']);
    expect(items[0]!.kind).toBe('command');
    expect(items[0]!.apply).toBe('/cull ');
  });

  test('offers everything for a bare slash', async () => {
    const { items } = await getSuggestions('/', process.cwd());
    expect(items.length).toBe(COMMANDS.length);
  });

  test('is case-insensitive on the typed prefix', async () => {
    const { items } = await getSuggestions('/CU', process.cwd());
    expect(items.map((i) => i.label)).toEqual(['/cull']);
  });

  test('stops completing commands once a space is typed', async () => {
    expect(await getSuggestions('/cull ', process.cwd())).toEqual({ items: [], hiddenCount: 0 });
  });

  test('offers nothing for a prefix no command matches', async () => {
    expect((await getSuggestions('/zzz', process.cwd())).items).toEqual([]);
  });
});

describe('getSuggestions, in mention mode', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'shoots-suggest-'));
    await mkdir(path.join(root, 'raw files'));
    await mkdir(path.join(root, 'raws'));
    await mkdir(path.join(root, '.hidden'));
    await writeFile(path.join(root, 'readme.md'), 'x');
    await writeFile(path.join(root, 'rate.json'), 'x');
    for (let i = 0; i < 10; i++) await writeFile(path.join(root, `shot${i}.cr3`), 'x');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('lists directories before files', async () => {
    const { items } = await getSuggestions('/cull @r', root);
    expect(items.slice(0, 2).map((i) => i.label)).toEqual(['raw files/', 'raws/']);
    expect(items.map((i) => i.hint).slice(0, 2)).toEqual(['dir', 'dir']);
  });

  test('marks a directory with a trailing slash and no trailing space', async () => {
    const { items } = await getSuggestions('/cull @raws', root);
    const dir = items.find((i) => i.label === 'raws/')!;
    expect(dir.apply).toBe('/cull @raws/');
  });

  test('finishes a file with a trailing space, ready for the next argument', async () => {
    const { items } = await getSuggestions('/cull @readme', root);
    expect(items[0]!.apply).toBe('/cull @readme.md ');
    expect(items[0]!.kind).toBe('path');
  });

  test('quotes a completion containing a space', async () => {
    const { items } = await getSuggestions('/cull @raw', root);
    expect(items.find((i) => i.label === 'raw files/')!.apply).toBe('/cull @"raw files/"');
  });

  // The mention pattern stops at whitespace and at either quote, so a partial
  // that already contains a space is not a mention to complete.
  test('does not treat a half-typed path with a space as a mention', async () => {
    expect(await getSuggestions('/cull @raw f', root)).toEqual({ items: [], hiddenCount: 0 });
  });

  test('preserves everything typed before the mention', async () => {
    const { items } = await getSuggestions('/cull --top 5 @readme', root);
    expect(items[0]!.apply).toBe('/cull --top 5 @readme.md ');
  });

  test('completes inside a subdirectory', async () => {
    await writeFile(path.join(root, 'raws', 'inner.cr3'), 'x');
    const { items } = await getSuggestions('/cull @raws/in', root);
    expect(items[0]!.label).toBe('inner.cr3');
    expect(items[0]!.apply).toBe('/cull @raws/inner.cr3 ');
  });

  test('accepts a backslash-separated path, as Windows users type it', async () => {
    const { items } = await getSuggestions('/cull @raws\\in', root);
    expect(items[0]!.label).toBe('inner.cr3');
  });

  test('hides dot-prefixed entries', async () => {
    const { items } = await getSuggestions('/cull @', root);
    expect(items.map((i) => i.label)).not.toContain('.hidden/');
  });

  test('caps the list and reports how much was cut', async () => {
    const { items, hiddenCount } = await getSuggestions('/cull @shot', root);
    expect(items.length).toBe(6);
    expect(hiddenCount).toBe(4);
  });

  test('offers nothing for a directory that does not exist', async () => {
    expect(await getSuggestions('/cull @nowhere/x', root)).toEqual({ items: [], hiddenCount: 0 });
  });

  test('ignores an @ that is not the last token', async () => {
    expect((await getSuggestions('/cull @raws --top', root)).items).toEqual([]);
  });

  test('offers nothing when there is no mention at all', async () => {
    expect(await getSuggestions('cull raws', root)).toEqual({ items: [], hiddenCount: 0 });
  });
});
