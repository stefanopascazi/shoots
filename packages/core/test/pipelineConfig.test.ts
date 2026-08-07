/**
 * The declarative pipeline config.
 *
 * The contract worth defending is that a broken config reports *every* problem
 * at once — reporting the first one turns editing a pipeline into a guessing
 * game — and that it fails at load rather than twenty minutes into a run.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadPipelineConfig,
  parsePipelineConfig,
  parseVarOverrides,
  PipelineConfigError,
  PIPELINE_VERSION,
} from '../src/pipeline/PipelineConfig.js';

const MINIMAL = `
version: 2
steps:
  - run: rate
`;

const issuesOf = (yaml: string, options?: Parameters<typeof parsePipelineConfig>[1]): string[] => {
  try {
    parsePipelineConfig(yaml, options);
  } catch (err) {
    if (err instanceof PipelineConfigError) return err.issues;
    throw err;
  }
  throw new Error('expected the config to be rejected');
};

describe('parsePipelineConfig, on a valid file', () => {
  test('normalizes every optional field', () => {
    const cfg = parsePipelineConfig(MINIMAL);
    expect(cfg.version).toBe(PIPELINE_VERSION);
    expect(cfg.name).toBeUndefined();
    expect(cfg.vars).toEqual({});
    expect(cfg.defaults).toEqual({});
    expect(cfg.steps).toEqual([
      { id: 'rate', run: 'rate', args: [], with: {}, enabled: true, continueOnError: false },
    ]);
  });

  test('defaults a step id to its command path and collapses inner whitespace', () => {
    const cfg = parsePipelineConfig(`
version: 2
steps:
  - run: "develop    export"
`);
    expect(cfg.steps[0]!.run).toBe('develop export');
    expect(cfg.steps[0]!.id).toBe('develop export');
  });

  test('keeps scalars typed and lists intact under with:', () => {
    const cfg = parsePipelineConfig(`
version: 2
steps:
  - run: rate
    with:
      write-xmp: true
      top: 20
      profile: my-style
      labels: [keep, reject]
`);
    expect(cfg.steps[0]!.with).toEqual({
      'write-xmp': true,
      top: 20,
      profile: 'my-style',
      labels: ['keep', 'reject'],
    });
  });

  test('accepts a bare scalar as a single positional argument', () => {
    const cfg = parsePipelineConfig(`
version: 2
steps:
  - run: rate
    args: /shoots/today
`);
    expect(cfg.steps[0]!.args).toEqual(['/shoots/today']);
  });

  test('reads continue-on-error under either spelling', () => {
    const dashed = parsePipelineConfig(`
version: 2
steps:
  - run: rate
    continue-on-error: true
`);
    const camel = parsePipelineConfig(`
version: 2
steps:
  - run: rate
    continueOnError: true
`);
    expect(dashed.steps[0]!.continueOnError).toBe(true);
    expect(camel.steps[0]!.continueOnError).toBe(true);
  });

  test('treats enabled as opt-out, not opt-in', () => {
    const cfg = parsePipelineConfig(`
version: 2
steps:
  - run: rate
  - run: cull
    enabled: false
`);
    expect(cfg.steps.map((s) => s.enabled)).toEqual([true, false]);
  });
});

describe('variable interpolation', () => {
  test('resolves vars in declaration order, so one may build on the last', () => {
    const cfg = parsePipelineConfig(`
version: 2
vars:
  shoot: /photos/2026-08-02
  raw: \${shoot}/raw
steps:
  - run: import
    args: ["\${raw}"]
    with:
      dest: \${shoot}/keep
`);
    expect(cfg.vars.raw).toBe('/photos/2026-08-02/raw');
    expect(cfg.steps[0]!.args).toEqual(['/photos/2026-08-02/raw']);
    expect(cfg.steps[0]!.with.dest).toBe('/photos/2026-08-02/keep');
  });

  test('--var overrides replace the file value rather than being shadowed by it', () => {
    const cfg = parsePipelineConfig(
      `
version: 2
vars:
  shoot: /default
  raw: \${shoot}/raw
steps:
  - run: rate
    args: ["\${raw}"]
`,
      { vars: { shoot: '/override' } },
    );
    expect(cfg.vars.shoot).toBe('/override');
    expect(cfg.steps[0]!.args).toEqual(['/override/raw']);
  });

  test('reads ${env:NAME} from the environment', () => {
    process.env.SHOOTS_TEST_PIPELINE_VAR = '/from-env';
    try {
      const cfg = parsePipelineConfig(`
version: 2
steps:
  - run: rate
    args: ["\${env:SHOOTS_TEST_PIPELINE_VAR}"]
`);
      expect(cfg.steps[0]!.args).toEqual(['/from-env']);
    } finally {
      delete process.env.SHOOTS_TEST_PIPELINE_VAR;
    }
  });

  test('$${...} is a literal, not a reference', () => {
    const cfg = parsePipelineConfig(`
version: 2
steps:
  - run: exif
    with:
      caption: "cost: $\${nope}"
`);
    expect(cfg.steps[0]!.with.caption).toBe('cost: ${nope}');
  });

  test('leaves single-brace filename templates alone', () => {
    const cfg = parsePipelineConfig(`
version: 2
steps:
  - run: rename
    with:
      pattern: "{date}_{seq:4}.{ext}"
`);
    expect(cfg.steps[0]!.with.pattern).toBe('{date}_{seq:4}.{ext}');
  });

  test('names an unknown variable and lists the ones that do exist', () => {
    const issues = issuesOf(`
version: 2
vars:
  shoot: /a
steps:
  - run: rate
    args: ["\${nope}"]
`);
    expect(issues.length).toBe(1);
    expect(issues[0]).toMatch(/unknown variable 'nope'/);
    expect(issues[0]).toMatch(/defined: shoot/);
  });

  test('reports an unset environment variable', () => {
    delete process.env.SHOOTS_TEST_MISSING_VAR;
    const issues = issuesOf(`
version: 2
steps:
  - run: rate
    args: ["\${env:SHOOTS_TEST_MISSING_VAR}"]
`);
    expect(issues[0]).toMatch(/environment variable 'SHOOTS_TEST_MISSING_VAR' is not set/);
  });
});

describe('parsePipelineConfig, on a broken file', () => {
  test('rejects unparseable YAML', () => {
    expect(() => parsePipelineConfig('steps: [\n  - run: rate')).toThrow(/not valid YAML/);
  });

  test('rejects a document that is not a mapping', () => {
    expect(() => parsePipelineConfig('- run: rate')).toThrow(/must be a YAML mapping/);
  });

  test('explains that version 1 was never executable', () => {
    expect(() => parsePipelineConfig('version: 1\nsteps: []')).toThrow(/never executable/);
  });

  test('names the unsupported version', () => {
    expect(() => parsePipelineConfig('version: 3\nsteps: []')).toThrow(/unsupported pipeline version: 3/);
    expect(() => parsePipelineConfig('steps: []')).toThrow(/unsupported pipeline version: undefined/);
  });

  test('requires a non-empty steps list', () => {
    expect(() => parsePipelineConfig('version: 2\nsteps: []')).toThrow(/non-empty `steps` list/);
    expect(() => parsePipelineConfig('version: 2')).toThrow(/non-empty `steps` list/);
  });

  test('points a version 1 typed step at its version 2 equivalent', () => {
    const issues = issuesOf(`
version: 2
steps:
  - type: import
`);
    expect(issues[0]).toMatch(/version 1 `type:` form/);
    expect(issues[0]).toMatch(/write `run: import` instead/);
  });

  test('rejects duplicate step ids', () => {
    const issues = issuesOf(`
version: 2
steps:
  - run: rate
  - run: rate
`);
    expect(issues[0]).toMatch(/'rate' is already used/);
  });

  test('accepts the same command twice when the ids differ', () => {
    const cfg = parsePipelineConfig(`
version: 2
steps:
  - id: rate-raw
    run: rate
  - id: rate-jpg
    run: rate
`);
    expect(cfg.steps.map((s) => s.id)).toEqual(['rate-raw', 'rate-jpg']);
  });

  test('type-checks the booleans and the value shapes', () => {
    const issues = issuesOf(`
version: 2
name: 42
steps:
  - run: rate
    enabled: yes-please
    continue-on-error: 1
    with:
      nested:
        a: b
`);
    expect(issues).toContain('`name` must be a string');
    expect(issues.some((i) => /enabled must be true or false/.test(i))).toBe(true);
    expect(issues.some((i) => /continue-on-error must be true or false/.test(i))).toBe(true);
    expect(issues.some((i) => /must be a string, number, boolean or list/.test(i))).toBe(true);
  });

  test('collects every problem instead of stopping at the first', () => {
    const issues = issuesOf(`
version: 2
steps:
  - run: rate
    args: ["\${nope1}"]
  - run: cull
    args: ["\${nope2}"]
  - run: 7
`);
    expect(issues.length).toBe(3);
    expect(issues.join('\n')).toMatch(/nope1/);
    expect(issues.join('\n')).toMatch(/nope2/);
    expect(issues.join('\n')).toMatch(/steps\[2\]\.run must name a shoots command/);
  });

  test('reports a blank run: as a missing command', () => {
    expect(issuesOf('version: 2\nsteps:\n  - run: "   "')[0]).toMatch(/must name a shoots command/);
  });

  test('the error message is every issue, one per line', () => {
    const err = new PipelineConfigError(['first', 'second']);
    expect(err.name).toBe('PipelineConfigError');
    expect(err.message).toBe('first\nsecond');
    expect(err.issues).toEqual(['first', 'second']);
    expect(new PipelineConfigError('only').issues).toEqual(['only']);
  });
});

describe('parseVarOverrides', () => {
  test('splits on the first = so values may contain one', () => {
    expect(parseVarOverrides(['shoot=/photos/a=b'])).toEqual({ shoot: '/photos/a=b' });
  });

  test('trims the name but not the value', () => {
    expect(parseVarOverrides([' shoot = /photos '])).toEqual({ shoot: ' /photos ' });
  });

  test('accepts an empty value', () => {
    expect(parseVarOverrides(['shoot='])).toEqual({ shoot: '' });
  });

  test('rejects pairs with no name, listing all of them', () => {
    expect(() => parseVarOverrides(['bare'])).toThrow(/--var 'bare' must be name=value/);
    expect(() => parseVarOverrides(['=novalue'])).toThrow(/must be name=value/);
    try {
      parseVarOverrides(['bare', 'ok=1', 'alsobare']);
    } catch (err) {
      expect((err as PipelineConfigError).issues.length).toBe(2);
    }
  });

  test('is empty for no overrides', () => {
    expect(parseVarOverrides([])).toEqual({});
  });
});

describe('loadPipelineConfig', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test('reads and parses a file from disk', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'shoots-pipeline-'));
    const file = path.join(dir, 'p.yaml');
    await writeFile(file, MINIMAL);
    const cfg = await loadPipelineConfig(file);
    expect(cfg.steps[0]!.run).toBe('rate');
  });

  test('reports an unreadable path as a config error, not an fs error', async () => {
    expect(loadPipelineConfig(path.join(tmpdir(), 'no-such-shoots-pipeline.yaml'))).rejects.toThrow(
      /cannot read pipeline config/,
    );
  });
});
