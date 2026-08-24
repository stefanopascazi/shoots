/**
 * The `pipeline init` wizard, as a pure function of its answers.
 *
 * Three properties carry the design. It asks little: two questions to set up
 * training, five for a whole shoot pass, and never one whose answer a command
 * default already knows. The question list is *derived* — pick no `exif` step
 * and nothing asks for a studio name — which is what lets both front-ends stay
 * dumb. And what it writes is scaffolding: the arguments only the author can
 * supply, every command left on its defaults, the rest offered as commented
 * hints. Each preset is rendered and parsed back through `parsePipelineConfig`,
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

describe('how much it asks', () => {
  test('the first question is what you are setting up', () => {
    expect(nextQuestion({}, CONTEXT)?.id).toBe('intent');
    expect(ids({})).toEqual(['intent']);
  });

  test('training asks for one thing: the folder to learn from', () => {
    expect(ids({ intent: 'train' })).toEqual(['intent', 'vars.shoot']);
    const answers = presetAnswers('train', CONTEXT, { 'vars.shoot': 'D:/Shoots/edited' });
    expect(nextQuestion(answers, CONTEXT)).toBeNull();
    expect(selectedSteps(answers).map((s) => s.run)).toEqual(['develop init']);
  });

  test('the whole shoot pass is five questions, none of them a command default', () => {
    const answers = presetAnswers('shoot', CONTEXT);
    expect(Object.keys(answers)).toEqual(['intent', 'coverage', 'vars.card', 'vars.shoot', 'vars.studio']);
  });

  test('picking steps is what opens the step list', () => {
    const whole: Answers = { intent: 'shoot', coverage: 'all' };
    expect(ids(whole)).not.toContain('steps');

    const picking: Answers = { intent: 'shoot', coverage: 'pick' };
    const stepsQuestion = wizardQuestions(picking, CONTEXT).find((q) => q.id === 'steps') as Question;
    expect(stepsQuestion.kind).toBe('multiselect');
    const offered = (stepsQuestion as { choices: Array<{ value: string }> }).choices.map((c) => c.value);
    expect(offered).toContain('import');
    expect(offered).toContain('rename');
    expect(offered).not.toContain('develop-init'); // training is its own intent
    expect((stepsQuestion as { default: string[] }).default).toEqual([
      'import',
      'rename',
      'exif',
      'rate',
      'cull',
      'develop-edit',
    ]);
  });

  test('a variable is only asked for when a chosen step needs it', () => {
    const noExif: Answers = { intent: 'shoot', coverage: 'pick', steps: ['rate', 'cull'] };
    expect(ids(noExif)).toContain('vars.shoot');
    expect(ids(noExif)).not.toContain('vars.studio');
    expect(ids(noExif)).not.toContain('vars.card');

    const withImport: Answers = { intent: 'shoot', coverage: 'pick', steps: ['import', 'exif'] };
    expect(ids(withImport)).toContain('vars.card');
    expect(ids(withImport)).toContain('vars.studio');
  });

  test('steps run in catalog order, whatever order they were picked in', () => {
    const answers: Answers = { intent: 'shoot', coverage: 'pick', steps: ['develop-edit', 'rate', 'import'] };
    expect(selectedSteps(answers).map((s) => s.key)).toEqual(['import', 'rate', 'develop-edit']);
  });

  test('a pre-answered question is never asked', () => {
    const answers = presetAnswers('shoot', CONTEXT, { 'vars.shoot': 'D:/given' });
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

describe('the scaffolding it writes', () => {
  test('one folder answers every step after the offload', () => {
    const answers = presetAnswers('shoot', CONTEXT, { 'vars.shoot': 'D:/Shoots/smith' });
    const config = parsePipelineConfig(yamlFor(answers));
    expect(config.vars.shoot).toBe('D:/Shoots/smith');
    expect(config.steps.map((s) => s.run)).toEqual([
      'import',
      'rename',
      'exif',
      'rate',
      'cull',
      'develop edit',
    ]);
    // The offload reads the card and writes the shoot folder; the rest read it.
    expect(config.steps[0]!.args).toEqual([config.vars.card!]);
    expect(config.steps[0]!.with.dest).toBe('D:/Shoots/smith');
    for (const step of config.steps.slice(1)) expect(step.args).toEqual(['D:/Shoots/smith']);
  });

  test('no step carries a flag the command would have defaulted anyway', () => {
    const config = parsePipelineConfig(yamlFor(presetAnswers('shoot', CONTEXT)));
    const by = (run: string) => config.steps.find((s) => s.run === run)!;

    // What survives: the artist name, and the marks that make rate and cull one
    // pass. No profile, no threshold, no treatment, no editor, no concurrency.
    expect(Object.keys(by('exif').with)).toEqual(['set-artist']);
    expect(by('rate').with).toEqual({ mark: true });
    expect(by('cull').with).toEqual({ mark: true });
    expect(by('develop edit').with).toEqual({});
    expect(Object.keys(config.defaults)).toHaveLength(0);
  });

  test('the flags a command cannot run without are still written', () => {
    const config = parsePipelineConfig(yamlFor(presetAnswers('shoot', CONTEXT)));
    // `import --dest` and `rename --pattern` are required options; `recursive`
    // is what makes rename reach the dated subfolders the offload created.
    expect(config.steps[0]!.with.dest).toBe(config.vars.shoot);
    expect(String(config.steps[1]!.with.pattern)).toContain('{date}');
    expect(config.steps[1]!.with.recursive).toBe(true);
  });

  test('training is the single develop init command, on its own defaults', () => {
    const config = parsePipelineConfig(yamlFor(presetAnswers('train', CONTEXT)));
    expect(config.name).toBe('develop-training');
    expect(config.steps).toHaveLength(1);
    expect(config.steps[0]!.run).toBe('develop init');
    expect(config.steps[0]!.with).toEqual({});
  });

  test('the hints are comments: they name real flags and change nothing', () => {
    const yaml = yamlFor(presetAnswers('shoot', CONTEXT));
    expect(yaml).toContain('# also: profile: generic | wedding | street'); // from the context, not hardcoded
    expect(yaml).toContain('# also: treatment: color | bw');
    for (const line of yaml.split('\n')) {
      if (line.includes('also:')) expect(line.trimStart().startsWith('#')).toBe(true);
    }
  });

  test('the studio name reaches the artist tag', () => {
    const answers = presetAnswers('shoot', CONTEXT, { 'vars.studio': 'Jane Doe Photography' });
    const config = parsePipelineConfig(yamlFor(answers));
    expect(config.steps.find((step) => step.run === 'exif')!.with['set-artist']).toBe('Jane Doe Photography');
  });

  test('every preset renders a file that parses, with the steps it promised', () => {
    for (const preset of PRESETS) {
      const answers = presetAnswers(preset.id, CONTEXT);
      const yaml = yamlFor(answers);
      const config = parsePipelineConfig(yaml);
      expect(config.version).toBe(2);
      expect(config.name).toBe(preset.name);
      expect(config.steps).toHaveLength(preset.steps.length);
      expect(yaml.startsWith('# Scaffolding from `shoots pipeline init`')).toBe(true);
    }
  });

  test('a value that needs quoting survives the round trip', () => {
    const answers = presetAnswers('shoot', CONTEXT, {
      coverage: 'pick',
      steps: ['rename'],
      'vars.shoot': 'D:/Shoots/#3: the one with spaces',
    });
    const config = parsePipelineConfig(yamlFor(answers));
    expect(config.steps[0]!.args[0]).toBe('D:/Shoots/#3: the one with spaces');
  });

  test('a pipeline with no steps is refused rather than written empty', () => {
    expect(() => buildDraft({ intent: 'shoot', coverage: 'pick', steps: [] }, CONTEXT)).toThrow(
      /at least one step/,
    );
  });
});
