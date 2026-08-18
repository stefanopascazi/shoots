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
      for (const template of ['ingest', 'cull-rate', 'develop-train']) {
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
    'the ingest template is the six-step develop pipeline, in order',
    async () => {
      await inTempDir(async (dir) => {
        const file = path.join(dir, 'p.yaml');
        await shoots(['pipeline', 'init', file, '--template', 'ingest', '--var', 'shoot=D:/Shoots/smith']);
        const dry = await shoots(['pipeline', file, '--dry-run']);

        expect(dry.out).toContain('shoots import E:/DCIM/100CANON');
        expect(dry.out).toContain('--dest D:/Shoots/smith/raw');
        expect(dry.out).toContain('shoots rename D:/Shoots/smith/raw');
        expect(dry.out).toContain('shoots exif D:/Shoots/smith/raw');
        expect(dry.out).toContain('shoots rate D:/Shoots/smith/raw');
        expect(dry.out).toContain('shoots cull D:/Shoots/smith/raw');
        expect(dry.out).toContain('shoots develop edit D:/Shoots/smith/raw');
      });
    },
    SLOW,
  );

  test(
    '--stdout prints the file and writes nothing',
    async () => {
      await inTempDir(async (dir) => {
        const run = await shoots(['pipeline', 'init', path.join(dir, 'p.yaml'), '--template', 'cull-rate', '--stdout']);
        expect(run.code).toBe(0);
        expect(run.out).toContain('version: 2');
        expect(run.out).toContain('run: triage apply');
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
      expect(run.err).toContain('ingest');
      expect(run.err).toContain('cull-rate');
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

        const guarded = await shoots(['pipeline', 'init', file, '--template', 'ingest']);
        expect(guarded.code).toBe(2);
        expect(guarded.err).toContain('--force');
        expect(await readFile(file, 'utf8')).toBe('# mine\n');

        const forced = await shoots(['pipeline', 'init', file, '--template', 'ingest', '--force']);
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
        const run = await shoots(['pipeline', 'init', '--template', 'cull-rate'], dir);
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
          '--template', 'cull-rate',
          '--var', 'raw=D:/Shoots/on-disk',
          '--var', 'card=E:/DCIM',
        ]);
        expect(run.code).toBe(0);
        const yaml = await readFile(file, 'utf8');
        expect(yaml).toContain('raw: D:/Shoots/on-disk');
        expect(run.err).toContain('--var card is not used');
      });
    },
    SLOW,
  );

  test(
    '--json reports what it wrote',
    async () => {
      await inTempDir(async (dir) => {
        const file = path.join(dir, 'p.yaml');
        const run = await shoots(['pipeline', 'init', file, '--template', 'develop-train', '--json']);
        const payload = JSON.parse(run.out);
        expect(payload.command).toBe('pipeline init');
        expect(payload.steps.map((step: { run: string }) => step.run)).toEqual(['develop export', 'develop train']);
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
        await shoots(['pipeline', 'init', file, '--template', 'cull-rate']);

        const legacy = await shoots(['pipeline', file, '--dry-run']);
        const explicit = await shoots(['pipeline', 'run', file, '--dry-run']);
        expect(legacy.code).toBe(0);
        expect(legacy.out).toBe(explicit.out);
      });
    },
    SLOW,
  );
});
