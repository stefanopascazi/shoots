/**
 * The `pipeline init` wizard, as a pure function of its answers.
 *
 * Two properties matter more than the individual questions. First, the question
 * list is *derived*: pick no `exif` step and nothing ever asks for a studio
 * name, which is what lets both front-ends stay dumb. Second, whatever it
 * renders must load: every preset is generated, parsed back through
 * `parsePipelineConfig`, and checked for the variables and flags it claimed —
 * because a wizard that emits a file the runner rejects is worse than no wizard.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildDraft,
  draftHeader,
  makeContext,
  nextQuestion,
  parseAnswer,
  parsePipelineConfig,
  presetAnswers,
  PRESETS,
  renderPipelineYaml,
  selectedSteps,
  validateAnswer,
  wizardQuestions,
  type Answers,
  type Question,
} from '../src/index.js';

const CONTEXT = makeContext({
  profiles: ['generic', 'wedding', 'street'],
  editors: ['acr', 'rapidraw'],
  labels: ['reject', 'select'],
});

const ids = (answers: Answers): string[] => wizardQuestions(answers, CONTEXT).map((q) => q.id);

const yamlFor = (answers: Answers): string =>
  renderPipelineYaml(buildDraft(answers, CONTEXT), { header: draftHeader('my.yaml') });

describe('question flow', () => {
  test('the first question is the preset, and nothing else is known yet', () => {
    const first = nextQuestion({}, CONTEXT);
    expect(first?.id).toBe('preset');
    expect(ids({})).toEqual(['preset']);
  });

  test('the steps a preset selects drive which questions exist', () => {
    const answers: Answers = { preset: 'cull-rate', name: 'x' };
    const stepsQuestion = wizardQuestions(answers, CONTEXT).find((q) => q.id === 'steps') as Question;
    expect(stepsQuestion.kind).toBe('multiselect');
    expect((stepsQuestion as { default: string[] }).default).toEqual(['rate', 'cull', 'triage-apply']);
  });

  test('no exif step means no studio question, and no import means raw is asked directly', () => {
    const withoutExif: Answers = { preset: 'custom', name: 'x', steps: ['rate'] };
    expect(ids(withoutExif)).toContain('vars.raw');
    expect(ids(withoutExif)).not.toContain('vars.studio');
    expect(ids(withoutExif)).not.toContain('vars.shoot');

    const withExifAndImport: Answers = { preset: 'custom', name: 'x', steps: ['import', 'exif'] };
    expect(ids(withExifAndImport)).toContain('vars.studio');
    expect(ids(withExifAndImport)).toContain('vars.shoot');
    expect(ids(withExifAndImport)).not.toContain('vars.raw');
  });

  test('steps run in catalog order, whatever order they were picked in', () => {
    const answers: Answers = { preset: 'custom', name: 'x', steps: ['develop-edit', 'rate', 'import'] };
    expect(selectedSteps(answers).map((s) => s.key)).toEqual(['import', 'rate', 'develop-edit']);
  });

  test('nextQuestion returns null only once every question has an answer', () => {
    const answers = presetAnswers('ingest', CONTEXT);
    expect(nextQuestion(answers, CONTEXT)).toBeNull();
    delete answers['rename.pattern'];
    expect(nextQuestion(answers, CONTEXT)?.id).toBe('rename.pattern');
  });

  test('a pre-answered question is never asked', () => {
    const answers = presetAnswers('ingest', CONTEXT, { 'vars.shoot': 'D:/given' });
    expect(answers['vars.shoot']).toBe('D:/given');
  });
});

describe('answer parsing', () => {
  const select: Question = {
    kind: 'select',
    id: 'q',
    label: 'q',
    choices: [
      { value: 'a', label: 'a' },
      { value: 'b', label: 'b' },
    ],
    default: 'a',
  };
  const multi: Question = { ...select, kind: 'multiselect', default: ['a'], minimum: 1 } as Question;

  test('empty input takes the default', () => {
    expect(parseAnswer(select, '')).toBe('a');
    expect(parseAnswer({ kind: 'confirm', id: 'c', label: 'c', default: true }, '  ')).toBe(true);
  });

  test('a select accepts the value or its position', () => {
    expect(parseAnswer(select, 'b')).toBe('b');
    expect(parseAnswer(select, '2')).toBe('b');
    expect(() => parseAnswer(select, 'z')).toThrow();
  });

  test('a multiselect takes a mixed, de-duplicated list, and - means none', () => {
    expect(parseAnswer(multi, '2, a, 1')).toEqual(['b', 'a']);
    expect(parseAnswer(multi, '-')).toEqual([]);
    expect(validateAnswer(multi, [])).toContain('at least 1');
  });

  test('yes/no words and digits both answer a confirm', () => {
    const confirm: Question = { kind: 'confirm', id: 'c', label: 'c', default: false };
    expect(parseAnswer(confirm, 'y')).toBe(true);
    expect(parseAnswer(confirm, 'NO')).toBe(false);
    expect(() => parseAnswer(confirm, 'maybe')).toThrow();
  });
});

describe('the file it writes', () => {
  test('with an import step, raw is derived from the shoot folder', () => {
    const answers = presetAnswers('ingest', CONTEXT, { 'vars.shoot': 'D:/Shoots/smith' });
    const config = parsePipelineConfig(yamlFor(answers));
    expect(config.vars.shoot).toBe('D:/Shoots/smith');
    expect(config.vars.raw).toBe('D:/Shoots/smith/raw');
    expect(config.steps[0]!.with.dest).toBe('D:/Shoots/smith/raw');
  });

  test('without an import step, raw is the folder the photographs are already in', () => {
    const answers = presetAnswers('cull-rate', CONTEXT, { 'vars.raw': 'D:/Shoots/on-disk' });
    const config = parsePipelineConfig(yamlFor(answers));
    expect(config.vars.raw).toBe('D:/Shoots/on-disk');
    expect(config.vars.shoot).toBeUndefined();
    expect(config.steps.map((s) => s.run)).toEqual(['rate', 'cull', 'triage apply']);
  });

  test('keywords become a list, the threshold stays a number, and empty answers drop the flag', () => {
    const answers: Answers = {
      ...presetAnswers('custom', CONTEXT, {
        steps: ['exif', 'cull'],
        'exif.keywords': 'wedding, smith , 2026',
        'cull.threshold': '140',
      }),
    };
    const config = parsePipelineConfig(yamlFor(answers));
    const exif = config.steps.find((s) => s.run === 'exif')!;
    expect(exif.with['set-keywords']).toEqual(['wedding', 'smith', '2026']);
    expect(config.steps.find((s) => s.run === 'cull')!.with.threshold).toBe(140);

    const noKeywords = parsePipelineConfig(
      yamlFor(presetAnswers('custom', CONTEXT, { steps: ['exif'], 'exif.keywords': '', 'exif.copyright': '' })),
    );
    const tags = noKeywords.steps[0]!.with;
    expect(tags['set-keywords']).toBeUndefined();
    expect(tags['set-copyright']).toBeUndefined();
    expect(tags['set-artist']).toBe('Your Name'); // placeholder, never an empty tag
  });

  test('the studio name reaches both the artist tag and the copyright line', () => {
    const answers = presetAnswers('custom', CONTEXT, {
      steps: ['exif'],
      'vars.studio': 'Jane Doe Photography',
    });
    const config = parsePipelineConfig(yamlFor(answers));
    expect(config.steps[0]!.with['set-artist']).toBe('Jane Doe Photography');
    expect(config.steps[0]!.with['set-copyright']).toContain('Jane Doe Photography');
  });

  test('every preset renders a file that parses, with the steps it promised', () => {
    for (const preset of PRESETS) {
      if (preset.steps.length === 0) continue;
      const answers = presetAnswers(preset.id, CONTEXT);
      const yaml = yamlFor(answers);
      const config = parsePipelineConfig(yaml);
      expect(config.version).toBe(2);
      expect(config.name).toBe(preset.name);
      expect(config.steps.length).toBe(preset.steps.length);
      expect(yaml.startsWith('# Written by `shoots pipeline init`')).toBe(true);
    }
  });

  test('a value that needs quoting survives the round trip', () => {
    const answers = presetAnswers('custom', CONTEXT, {
      steps: ['rename'],
      'vars.raw': 'D:/Shoots/#3: the one with spaces',
      'rename.pattern': '{date}: {camera}.{ext}',
    });
    const config = parsePipelineConfig(yamlFor(answers));
    expect(config.steps[0]!.args[0]).toBe('D:/Shoots/#3: the one with spaces');
    expect(config.steps[0]!.with.pattern).toBe('{date}: {camera}.{ext}');
  });

  test('a pipeline with no steps is refused rather than written empty', () => {
    expect(() => buildDraft({ preset: 'custom', name: 'x', steps: [] }, CONTEXT)).toThrow(/at least one step/);
  });

  test('concurrency is only suggested when a step actually takes it', () => {
    expect(buildDraft(presetAnswers('ingest', CONTEXT), CONTEXT).defaults.concurrency).toBe(8);
    const renameOnly = buildDraft({ preset: 'custom', name: 'x', steps: ['rename'] }, CONTEXT);
    expect(renameOnly.defaults.concurrency).toBeUndefined();
  });
});
