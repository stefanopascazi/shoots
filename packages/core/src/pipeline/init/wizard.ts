/**
 * The wizard itself: a pure state machine over answers.
 *
 * `nextQuestion(answers)` is the whole interaction protocol — ask it, store the
 * answer, ask again, stop when it returns null. Which questions exist depends on
 * the answers already given (no `exif` step, no studio name to ask for), so the
 * front-ends never decide what to ask: they only render a question and hand back
 * a value. That is what keeps the Ink screen and the plain prompt in step with
 * each other, and what makes the flow testable without a terminal.
 */
import type { PipelineValue } from '../PipelineConfig.js';
import type { PipelineDraft, DraftVar } from './draft.js';
import {
  STEP_BLUEPRINTS,
  PRESETS,
  findBlueprint,
  findPreset,
  type CatalogContext,
  type StepBlueprint,
} from './catalog.js';
import { defaultOf, type Answers, type Question, type TextQuestion } from './questions.js';

/** Fallbacks so a caller may omit the lists the CLI owns (tests, mostly). */
const DEFAULT_CONTEXT: CatalogContext = {
  profiles: ['generic'],
  editors: ['acr'],
  labels: ['reject', 'select', 'review', 'second-pass'],
};

export function makeContext(partial: Partial<CatalogContext> = {}): CatalogContext {
  return {
    profiles: partial.profiles?.length ? partial.profiles : DEFAULT_CONTEXT.profiles,
    editors: partial.editors?.length ? partial.editors : DEFAULT_CONTEXT.editors,
    labels: partial.labels?.length ? partial.labels : DEFAULT_CONTEXT.labels,
  };
}

const presetQuestion = (): Question => ({
  kind: 'select',
  id: 'preset',
  label: 'What should this pipeline do?',
  hint: 'A starting point — you pick the exact steps next',
  choices: PRESETS.map((preset) => ({ value: preset.id, label: preset.label, hint: preset.hint })),
  default: PRESETS[0]!.id,
});

const nameQuestion = (presetId: string): Question => ({
  kind: 'text',
  id: 'name',
  label: 'Pipeline name',
  hint: 'Shown while it runs',
  default: findPreset(presetId)?.name ?? 'my-pipeline',
});

const stepsQuestion = (presetId: string): Question => ({
  kind: 'multiselect',
  id: 'steps',
  label: 'Which steps should it run?',
  hint: 'They run in this order, top to bottom',
  choices: STEP_BLUEPRINTS.map((step) => ({ value: step.key, label: step.label, hint: step.hint })),
  default: findPreset(presetId)?.steps ?? [],
  minimum: 1,
});

/** The steps chosen, always in catalog order — that order is the run order. */
export function selectedSteps(answers: Answers): StepBlueprint[] {
  const chosen = answers.steps;
  const keys = Array.isArray(chosen) ? chosen : [];
  return STEP_BLUEPRINTS.filter((step) => keys.includes(step.key));
}

const hasImport = (steps: StepBlueprint[]): boolean => steps.some((step) => step.key === 'import');

/**
 * Variable questions implied by the chosen steps.
 *
 * `raw` is the one variable everything else hangs off. With an import step it is
 * derived (`${shoot}/raw`) because that is where the offload will put the files;
 * without one the photographs already exist somewhere, so it is asked directly.
 */
function varQuestions(steps: StepBlueprint[]): TextQuestion[] {
  const needed = new Set(steps.flatMap((step) => step.vars));
  const questions: TextQuestion[] = [];

  if (needed.has('card')) {
    questions.push({
      kind: 'text',
      id: 'vars.card',
      label: 'Card or source folder',
      hint: 'What the offload reads from',
      default: 'E:/DCIM/100CANON',
    });
  }
  if (needed.has('raw')) {
    questions.push(
      hasImport(steps)
        ? {
            kind: 'text',
            id: 'vars.shoot',
            label: 'Shoot folder',
            hint: 'The photographs land in <shoot>/raw',
            default: 'D:/Shoots/my-shoot',
          }
        : {
            kind: 'text',
            id: 'vars.raw',
            label: 'Folder holding the photographs',
            default: 'D:/Shoots/my-shoot',
          },
    );
  }
  if (needed.has('studio')) {
    questions.push({
      kind: 'text',
      id: 'vars.studio',
      label: 'Artist or studio name',
      hint: 'Written as the Artist/Creator tag',
      // A placeholder rather than an empty default: `--template` answers every
      // question for you, and an empty Artist tag written over a card is worse
      // than an obviously-wrong one waiting to be edited.
      default: 'Your Name',
    });
  }
  if (needed.has('dataset')) {
    questions.push({
      kind: 'text',
      id: 'vars.dataset',
      label: 'Training dataset file',
      hint: 'JSONL written by develop export and read by develop train',
      default: 'develop-dataset.jsonl',
    });
  }
  if (needed.has('profileFile')) {
    questions.push({
      kind: 'text',
      id: 'vars.profileFile',
      label: 'Profile file to write',
      default: 'my-style.json',
    });
  }
  return questions;
}

/** Every question the current answers imply, in the order they are asked. */
export function wizardQuestions(answers: Answers, context: CatalogContext = DEFAULT_CONTEXT): Question[] {
  const questions: Question[] = [presetQuestion()];

  const preset = typeof answers.preset === 'string' ? answers.preset : undefined;
  if (preset === undefined) return questions;

  questions.push(nameQuestion(preset), stepsQuestion(preset));
  if (!Array.isArray(answers.steps)) return questions;

  const steps = selectedSteps(answers);
  questions.push(...varQuestions(steps));
  for (const step of steps) questions.push(...step.questions(context));
  return questions;
}

/** The first question with no answer yet, or null when the wizard is done. */
export function nextQuestion(answers: Answers, context: CatalogContext = DEFAULT_CONTEXT): Question | null {
  for (const question of wizardQuestions(answers, context)) {
    if (!(question.id in answers)) return question;
  }
  return null;
}

/** Answer sheet for `--template`: every question left at its default. */
export function presetAnswers(
  presetId: string,
  context: CatalogContext = DEFAULT_CONTEXT,
  overrides: Answers = {},
): Answers {
  const answers: Answers = { preset: presetId, ...overrides };
  let guard = 0;
  for (;;) {
    const question = nextQuestion(answers, context);
    if (!question) return answers;
    answers[question.id] = defaultOf(question);
    if (++guard > 200) throw new Error('pipeline init: question list did not converge');
  }
}

/** Concurrency the `defaults:` block suggests when any step accepts the flag. */
export const DEFAULT_CONCURRENCY = 8;

function draftVars(answers: Answers, steps: StepBlueprint[]): DraftVar[] {
  const needed = new Set(steps.flatMap((step) => step.vars));
  const value = (id: string, fallback = ''): string => {
    const raw = answers[id];
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : fallback;
  };

  const vars: DraftVar[] = [];
  if (needed.has('card')) {
    vars.push({ name: 'card', value: value('vars.card'), comment: 'the card, or wherever the offload reads from' });
  }
  if (needed.has('raw')) {
    if (hasImport(steps)) {
      vars.push({ name: 'shoot', value: value('vars.shoot') });
      vars.push({ name: 'raw', value: '${shoot}/raw', comment: 'a var may build on the ones above it' });
    } else {
      vars.push({ name: 'raw', value: value('vars.raw') });
    }
  }
  if (needed.has('studio')) vars.push({ name: 'studio', value: value('vars.studio') });
  if (needed.has('dataset')) vars.push({ name: 'dataset', value: value('vars.dataset') });
  if (needed.has('profileFile')) vars.push({ name: 'profileFile', value: value('vars.profileFile') });
  return vars;
}

/** Answers → the pipeline file, still unrendered. */
export function buildDraft(answers: Answers, context: CatalogContext = DEFAULT_CONTEXT): PipelineDraft {
  const steps = selectedSteps(answers);
  if (steps.length === 0) throw new Error('pipeline init: a pipeline needs at least one step');

  const defaults: Record<string, PipelineValue> = {};
  if (steps.some((step) => step.concurrent)) defaults.concurrency = DEFAULT_CONCURRENCY;

  const name = typeof answers.name === 'string' && answers.name.trim().length > 0 ? answers.name.trim() : undefined;

  return {
    name,
    vars: draftVars(answers, steps),
    defaults,
    steps: steps.map((step) => step.build(answers, context)),
  };
}

/** The comment block written above a generated file. */
export function draftHeader(fileName: string): string[] {
  return [
    'Written by `shoots pipeline init`. It is an ordinary pipeline file: edit it,',
    'version it, share it. Every step is a shoots command you could have typed.',
    '',
    `  shoots pipeline ${fileName} --dry-run   # print the command lines, run nothing`,
    `  shoots pipeline ${fileName}             # run it`,
    `  shoots pipeline ${fileName} --var shoot=D:/Shoots/next-one`,
  ];
}

export { STEP_BLUEPRINTS, PRESETS, findBlueprint, findPreset };
export type { CatalogContext, StepBlueprint };
