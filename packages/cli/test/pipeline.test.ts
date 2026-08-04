/**
 * `shoots pipeline` — the YAML → command-line mapping, and what it refuses.
 *
 * The mapping is the whole feature: a pipeline is trusted to run six commands
 * over a photographer's card unattended, so a flag that lands on the wrong step,
 * a variable that silently resolves to nothing, or a typo that is only noticed
 * at step five are all failures with real cost. Driven through the built CLI for
 * the same reason the triage cycle is: what is under test *is* the wiring.
 *
 * `--dry-run` is the workhorse here — it exercises loading, interpolation and
 * the full commander resolution, and prints exactly what would have run.
 */
import { describe, expect, test, beforeAll } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

/** Write a pipeline to a temp file and run it, returning both streams. */
async function pipeline(yaml: string, ...args: string[]): Promise<Run> {
  const dir = await mkdtemp(path.join(tmpdir(), 'shoots-pipeline-'));
  const file = path.join(dir, 'pipeline.yaml');
  await writeFile(file, yaml, 'utf8');
  try {
    const proc = Bun.spawn(['node', CLI, 'pipeline', file, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out, err };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const HEADER = 'version: 2\nname: test\n';

describe('argument mapping', () => {
  test(
    'positionals, value flags, boolean flags and lists reach the command line',
    async () => {
      const run = await pipeline(
        HEADER +
          `steps:
  - run: cull
    args: /photos
    with:
      threshold: 100
      mark: true
      mark-label: reject
      copy: false
  - run: exif
    args: /photos
    with:
      set-keywords: [wedding, smith, "2026"]
`,
        '--dry-run',
      );
      expect(run.code).toBe(0);
      expect(run.out).toContain('shoots cull /photos --threshold 100 --mark --mark-label reject');
      // `copy: false` on a plain flag means "leave it off", not "pass something".
      expect(run.out).not.toContain('--copy');
      // A list becomes one comma-separated value, which is what these flags take.
      expect(run.out).toContain('--set-keywords wedding,smith,2026');
    },
    SLOW,
  );

  test(
    'camelCase and --dashed option keys name the same flag',
    async () => {
      const run = await pipeline(
        HEADER + 'steps:\n  - run: rate\n    args: /photos\n    with:\n      writeXmp: true\n      "--profile": street\n',
        '--dry-run',
      );
      expect(run.code).toBe(0);
      expect(run.out).toContain('--write-xmp');
      expect(run.out).toContain('--profile street');
    },
    SLOW,
  );

  test(
    'false on a negatable option emits the --no- form',
    async () => {
      const run = await pipeline(
        HEADER + 'steps:\n  - run: cull\n    args: /photos\n    with:\n      focus-rescue: false\n',
        '--dry-run',
      );
      expect(run.code).toBe(0);
      expect(run.out).toContain('--no-focus-rescue');
    },
    SLOW,
  );

  test(
    'subcommands are addressed by path',
    async () => {
      const run = await pipeline(
        HEADER + 'steps:\n  - run: develop export\n    args: /photos\n    with:\n      edited-only: true\n',
        '--dry-run',
      );
      expect(run.code).toBe(0);
      expect(run.out).toContain('shoots develop export /photos --edited-only');
    },
    SLOW,
  );

  test(
    'defaults reach only the steps whose command accepts them',
    async () => {
      const run = await pipeline(
        HEADER + 'defaults:\n  concurrency: 8\nsteps:\n  - run: rate\n    args: /photos\n  - run: rename\n    args: /photos\n    with:\n      pattern: "{orig}.{ext}"\n',
        '--dry-run',
      );
      expect(run.code).toBe(0);
      expect(run.out).toContain('shoots rate /photos --concurrency 8');
      // rename has no --concurrency; a global default must not invent one.
      expect(run.out).toContain('shoots rename /photos --pattern');
      expect(run.out).not.toContain('rename /photos --concurrency');
    },
    SLOW,
  );

  test(
    'a step may override a default',
    async () => {
      const run = await pipeline(
        HEADER + 'defaults:\n  concurrency: 8\nsteps:\n  - run: rate\n    args: /photos\n    with:\n      concurrency: 2\n',
        '--dry-run',
      );
      expect(run.out).toContain('--concurrency 2');
      expect(run.out).not.toContain('--concurrency 8');
    },
    SLOW,
  );
});

describe('variables', () => {
  test(
    'vars interpolate everywhere, build on each other, and --var overrides them',
    async () => {
      const yaml =
        HEADER +
        `vars:
  shoot: /shoots/smith
  raw: \${shoot}/raw
steps:
  - run: rate
    args: \${raw}
    with:
      profile: wedding
`;
      const plain = await pipeline(yaml, '--dry-run');
      expect(plain.out).toContain('shoots rate /shoots/smith/raw');

      // The override must reach the vars that were derived from it, not just
      // the direct references — that is the whole point of `--var`.
      const overridden = await pipeline(yaml, '--dry-run', '--var', 'shoot=/shoots/jones');
      expect(overridden.out).toContain('shoots rate /shoots/jones/raw');
    },
    SLOW,
  );

  test(
    'an unknown variable is a load error, never an empty string',
    async () => {
      const run = await pipeline(HEADER + 'steps:\n  - run: rate\n    args: "${nope}"\n');
      expect(run.code).toBe(2);
      expect(run.err).toContain("unknown variable 'nope'");
    },
    SLOW,
  );

  test(
    'a filename template is left alone',
    async () => {
      // Templates use single braces; only `${...}` is a variable reference.
      const run = await pipeline(
        HEADER + 'steps:\n  - run: rename\n    args: /photos\n    with:\n      pattern: "{date}_{seq:4}.{ext}"\n',
        '--dry-run',
      );
      expect(run.code).toBe(0);
      expect(run.out).toContain('{date}_{seq:4}.{ext}');
    },
    SLOW,
  );
});

describe('validation', () => {
  test(
    'every problem in the file is reported at once, before anything runs',
    async () => {
      const run = await pipeline(
        HEADER +
          `steps:
  - run: rate
    with:
      profil: wedding
  - run: cul
    args: /photos
  - run: develop
    args: /photos
`,
      );
      expect(run.code).toBe(2);
      expect(run.err).toContain('4 problem(s)');
      expect(run.err).toContain("needs 1 positional argument(s) <path>"); // rate, no args
      expect(run.err).toContain("has no option '--profil'");
      expect(run.err).toContain("no such shoots command 'cul'");
    },
    SLOW,
  );

  test(
    'a group command without a subcommand names the ones it has',
    async () => {
      const run = await pipeline(HEADER + 'steps:\n  - run: develop\n');
      expect(run.code).toBe(2);
      expect(run.err).toContain("'develop' needs a subcommand");
      expect(run.err).toContain('edit');
    },
    SLOW,
  );

  test(
    'a value on a boolean flag is refused rather than stringified',
    async () => {
      const run = await pipeline(HEADER + 'steps:\n  - run: rate\n    args: /photos\n    with:\n      mark: yes-please\n');
      expect(run.code).toBe(2);
      expect(run.err).toContain("'--mark' is a flag");
    },
    SLOW,
  );

  test(
    'duplicate step ids are refused, because --from addresses them',
    async () => {
      const run = await pipeline(
        HEADER + 'steps:\n  - id: pass\n    run: rate\n    args: /a\n  - id: pass\n    run: cull\n    args: /a\n',
      );
      expect(run.code).toBe(2);
      expect(run.err).toContain("'pass' is already used");
    },
    SLOW,
  );

  test(
    'the version 1 typed-step format is rejected with the migration named',
    async () => {
      const run = await pipeline('version: 1\nsteps:\n  - type: import\n    source: /a\n    dest: /b\n');
      expect(run.code).toBe(2);
      expect(run.err).toContain('version 1');
      expect(run.err).toContain('run:');
    },
    SLOW,
  );
});

describe('execution', () => {
  test(
    'steps run in order, a failure stops the rest, and the report says so',
    async () => {
      const run = await pipeline(
        HEADER +
          `steps:
  - id: first
    run: doctor
  - id: boom
    run: rename
    args: /nonexistent-shoots-path
    with:
      pattern: "{orig}.{ext}"
      dry-run: true
  - id: never
    run: doctor
`,
        '--json',
      );
      expect(run.code).toBe(1);
      const report = JSON.parse(run.out) as {
        ok: boolean;
        steps: Array<{ id: string; status: string; reason?: string }>;
      };
      expect(report.ok).toBe(false);
      expect(report.steps.map((s) => s.id)).toEqual(['first', 'boom', 'never']);
      expect(report.steps[0]!.status).toBe('ok');
      expect(report.steps[1]!.status).toBe('failed');
      expect(report.steps[2]!.status).toBe('skipped');
      expect(report.steps[2]!.reason).toContain('earlier step failed');
    },
    SLOW,
  );

  test(
    'continue-on-error lets the pipeline finish, still reporting failure',
    async () => {
      const run = await pipeline(
        HEADER +
          `steps:
  - id: boom
    run: rename
    args: /nonexistent-shoots-path
    with:
      pattern: "{orig}.{ext}"
    continue-on-error: true
  - id: after
    run: doctor
`,
        '--json',
      );
      expect(run.code).toBe(1);
      const report = JSON.parse(run.out) as { ok: boolean; steps: Array<{ id: string; status: string }> };
      expect(report.ok).toBe(false);
      expect(report.steps[1]!.status).toBe('ok');
    },
    SLOW,
  );

  test(
    '--from skips the earlier steps instead of dropping them',
    async () => {
      const run = await pipeline(
        HEADER + 'steps:\n  - id: one\n    run: doctor\n  - id: two\n    run: doctor\n',
        '--json',
        '--from',
        'two',
      );
      expect(run.code).toBe(0);
      const report = JSON.parse(run.out) as { steps: Array<{ id: string; status: string; reason?: string }> };
      expect(report.steps[0]!.status).toBe('skipped');
      expect(report.steps[0]!.reason).toContain('--from');
      expect(report.steps[1]!.status).toBe('ok');
    },
    SLOW,
  );

  test(
    '--from naming no step is a usage error, not a silent full run',
    async () => {
      const run = await pipeline(HEADER + 'steps:\n  - id: one\n    run: doctor\n', '--from', 'typo');
      expect(run.code).toBe(2);
      expect(run.err).toContain("--from 'typo' matches no step");
    },
    SLOW,
  );

  test(
    'a disabled step is reported, not executed',
    async () => {
      const run = await pipeline(
        HEADER + 'steps:\n  - id: off\n    run: doctor\n    enabled: false\n  - id: on\n    run: doctor\n',
        '--json',
      );
      expect(run.code).toBe(0);
      const report = JSON.parse(run.out) as { steps: Array<{ id: string; status: string; reason?: string }> };
      expect(report.steps[0]!.status).toBe('skipped');
      expect(report.steps[0]!.reason).toBe('disabled');
    },
    SLOW,
  );

  test(
    'a disabled step naming a command this build lacks still loads',
    async () => {
      // Forward compatibility: parking a future step must not break the file.
      const run = await pipeline(
        HEADER + 'steps:\n  - id: proofs\n    run: export\n    enabled: false\n  - run: doctor\n',
        '--dry-run',
      );
      expect(run.code).toBe(0);
      expect(run.out).toContain('proofs');
    },
    SLOW,
  );
});

describe('the shipped examples', () => {
  const examples = path.resolve(import.meta.dir, '../../../examples');

  for (const name of ['wedding-pipeline.yaml', 'model-upkeep.yaml']) {
    test(
      `${name} resolves against the current commands`,
      async () => {
        const proc = Bun.spawn(['node', CLI, 'pipeline', path.join(examples, name), '--dry-run'], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        expect(err).toBe('');
        expect(await proc.exited).toBe(0);
        expect(out).toContain('Dry run');
      },
      SLOW,
    );
  }
});
