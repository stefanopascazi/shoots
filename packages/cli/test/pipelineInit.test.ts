/**
 * `shoots pipeline init` — the file it writes, driven through the built CLI.
 *
 * The whole promise of the command is "you do not have to know the YAML", which
 * only holds if what it writes runs: every generated file here is handed
 * straight back to `shoots pipeline --dry-run`, which loads it, interpolates it
 * and resolves every step against the real commander tree. A wizard whose output
 * needs hand-fixing would be worse than the empty editor it replaces.
 *
 * The other half is the old spelling. `pipeline <file>` predates `init`, so it
 * is pinned as a default subcommand, not left to chance.
 */
import { describe, expect, test, beforeAll } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLI = path.resolve(import.meta.dir, '../dist/cli.js');
const SLOW = 60_000;

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error(`build the CLI first: ${CLI} is missing`);
});

interface Run {
  code: number;
  out: string;
  err: string;
}

async function shoots(args: string[], cwd?: string): Promise<Run> {
  const proc = Bun.spawn(['node', CLI, ...args], { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

/** A temp directory, cleaned up whatever the test does. */
async function inTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'shoots-init-'));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('templates', () => {
  test(
    'every template writes a file that `pipeline --dry-run` accepts',
    async () => {
      for (const template of ['shoot', 'train']) {
        await inTempDir(async (dir) => {
          const file = path.join(dir, `${template}.yaml`);
          const init = await shoots(['pipeline', 'init', file, '--template', template]);
          expect(init.code).toBe(0);
          expect(existsSync(file)).toBe(true);

          const dry = await shoots(['pipeline', file, '--dry-run']);
          expect(dry.err).toBe('');
          expect(dry.code).toBe(0);
          expect(dry.out).toContain('nothing executed');
        });
      }
    },
    SLOW,
  );

  test(
    'the shoot template is card-to-sidecars, on one folder, with no extra flags',
    async () => {
      await inTempDir(async (dir) => {
        const file = path.join(dir, 'p.yaml');
        await shoots(['pipeline', 'init', file, '--template', 'shoot', '--var', 'shoot=D:/Shoots/smith']);
        const dry = await shoots(['pipeline', file, '--dry-run']);

        expect(dry.out).toContain('--dest D:/Shoots/smith');
        expect(dry.out).toContain('shoots rename D:/Shoots/smith --pattern');
        expect(dry.out).toContain('shoots exif D:/Shoots/smith --set-artist');
        expect(dry.out).toContain('shoots rate D:/Shoots/smith --mark');
        expect(dry.out).toContain('shoots cull D:/Shoots/smith --mark');
        expect(dry.out).toContain('shoots develop edit D:/Shoots/smith');
        // Scaffolding: nothing the commands already default to.
        expect(dry.out).not.toContain('--profile');
        expect(dry.out).not.toContain('--threshold');
        expect(dry.out).not.toContain('--concurrency');
      });
    },
    SLOW,
  );

  test(
    'the train template is `develop init` on the folder, and nothing else',
    async () => {
      await inTempDir(async (dir) => {
        const file = path.join(dir, 'p.yaml');
        await shoots(['pipeline', 'init', file, '--template', 'train', '--var', 'shoot=D:/Shoots/edited']);
        const dry = await shoots(['pipeline', file, '--dry-run']);

        expect(dry.out).toContain('1 step(s)');
        expect(dry.out).toContain('shoots develop init D:/Shoots/edited');
      });
    },
    SLOW,
  );

  test(
    '--stdout prints the file and writes nothing',
    async () => {
      await inTempDir(async (dir) => {
        const run = await shoots(['pipeline', 'init', path.join(dir, 'p.yaml'), '--template', 'shoot', '--stdout']);
        expect(run.code).toBe(0);
        expect(run.out).toContain('version: 2');
        expect(run.out).toContain('run: develop edit');
        expect(run.out).toContain('# also:'); // the hints that make it scaffolding
        expect(existsSync(path.join(dir, 'p.yaml'))).toBe(false);
      });
    },
    SLOW,
  );

  test(
    'an unknown template names the ones that exist',
    async () => {
      const run = await shoots(['pipeline', 'init', '--template', 'weddings']);
      expect(run.code).toBe(2);
      expect(run.err).toContain('shoot');
      expect(run.err).toContain('train');
    },
    SLOW,
  );
});

describe('the file on disk', () => {
  test(
    'an existing file is never replaced without --force',
    async () => {
      await inTempDir(async (dir) => {
        const file = path.join(dir, 'p.yaml');
        await writeFile(file, '# mine\n', 'utf8');

        const guarded = await shoots(['pipeline', 'init', file, '--template', 'shoot']);
        expect(guarded.code).toBe(2);
        expect(guarded.err).toContain('--force');
        expect(await readFile(file, 'utf8')).toBe('# mine\n');

        const forced = await shoots(['pipeline', 'init', file, '--template', 'shoot', '--force']);
        expect(forced.code).toBe(0);
        expect(await readFile(file, 'utf8')).toContain('version: 2');
      });
    },
    SLOW,
  );

  test(
    'the default file name is used when none is given',
    async () => {
      await inTempDir(async (dir) => {
        const run = await shoots(['pipeline', 'init', '--template', 'shoot'], dir);
        expect(run.code).toBe(0);
        expect(existsSync(path.join(dir, 'shoots-pipeline.yaml'))).toBe(true);
        expect(run.out).toContain('--dry-run');
      });
    },
    SLOW,
  );

  test(
    '--var answers a variable, and one nothing asked for is reported',
    async () => {
      await inTempDir(async (dir) => {
        const file = path.join(dir, 'p.yaml');
        const run = await shoots([
          'pipeline', 'init', file,
          '--template', 'shoot',
          '--var', 'shoot=D:/Shoots/on-disk',
          '--var', 'lens=50mm',
        ]);
        expect(run.code).toBe(0);
        const yaml = await readFile(file, 'utf8');
        expect(yaml).toContain('shoot: D:/Shoots/on-disk');
        expect(run.err).toContain('--var lens is not used'); // no step declares it
      });
    },
    SLOW,
  );

  test(
    '--json reports what it wrote',
    async () => {
      await inTempDir(async (dir) => {
        const file = path.join(dir, 'p.yaml');
        const run = await shoots(['pipeline', 'init', file, '--template', 'train', '--json']);
        const payload = JSON.parse(run.out);
        expect(payload.command).toBe('pipeline init');
        expect(payload.steps.map((step: { run: string }) => step.run)).toEqual(['develop init']);
        expect(payload.issues).toEqual([]);
      });
    },
    SLOW,
  );

  test(
    'without a terminal, the interactive form refuses rather than guessing',
    async () => {
      await inTempDir(async (dir) => {
        const run = await shoots(['pipeline', 'init', path.join(dir, 'p.yaml')]);
        expect(run.code).toBe(2);
        expect(run.err).toContain('--template');
        expect(existsSync(path.join(dir, 'p.yaml'))).toBe(false);
      });
    },
    SLOW,
  );
});

describe('the old spelling', () => {
  test(
    '`pipeline <file>` still runs the file, now that `run` is a subcommand',
    async () => {
      await inTempDir(async (dir) => {
        const file = path.join(dir, 'p.yaml');
        await shoots(['pipeline', 'init', file, '--template', 'shoot']);

        const legacy = await shoots(['pipeline', file, '--dry-run']);
        const explicit = await shoots(['pipeline', 'run', file, '--dry-run']);
        expect(legacy.code).toBe(0);
        expect(legacy.out).toBe(explicit.out);
      });
    },
    SLOW,
  );
});
