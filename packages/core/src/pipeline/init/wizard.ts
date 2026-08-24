/**
 * The wizard itself: a pure state machine over answers.
 *
 * `nextQuestion(answers)` is the whole interaction protocol — ask it, store the
 * answer, ask again, stop when it returns null. Which questions exist depends on
 * the answers already given, so the front-ends never decide what to ask: they
 * only render a question and hand back a value. That is what keeps the Ink
 * screen and the plain prompt in step, and what makes the flow testable without
 * a terminal.
 *
 * It asks as little as it can get away with: what you are doing (a shoot, or
 * training your look), whether you want the whole pass or particular steps, and
 * then only what no default could supply — the folders, and the name that goes
 * in the Artist tag. Everything else is left to the commands and hinted at in
 * the file, because the output is scaffolding somebody will edit, not a
 * configuration they have to get right by answering questions.
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

const intentQuestion = (): Question => ({
  kind: 'select',
  id: 'intent',
  label: 'What are you setting up?',
  choices: PRESETS.map((preset) => ({ value: preset.id, label: preset.label, hint: preset.hint })),
  default: PRESETS[0]!.id,
});

const SHOOT_STEPS = findPreset('shoot')!.steps;

/** `exif → rate → cull → develop edit`, read off the catalog. */
const shootPassSummary = (): string =>
  STEP_BLUEPRINTS.filter((step) => SHOOT_STEPS.includes(step.key))
    .map((step) => step.run)
    .join(' → ');

const coverageQuestion = (): Question => ({
  kind: 'select',
  id: 'coverage',
  label: 'The whole pass, or particular steps?',
  choices: [
    { value: 'all', label: 'Everything', hint: shootPassSummary() },
    { value: 'pick', label: 'Pick the steps', hint: 'a folder already on disk needs no offload' },
  ],
  default: 'all',
});

const stepsQuestion = (): Question => ({
  kind: 'multiselect',
  id: 'steps',
  label: 'Which steps?',
  hint: 'They run in this order, top to bottom',
  choices: STEP_BLUEPRINTS.filter((step) => step.key !== 'develop-init').map((step) => ({
    value: step.key,
    label: step.label,
    hint: step.hint,
  })),
  default: [...SHOOT_STEPS],
  minimum: 1,
});

/** The steps this answer sheet implies, always in catalog (= run) order. */
export function selectedSteps(answers: Answers): StepBlueprint[] {
  const intent = typeof answers.intent === 'string' ? answers.intent : undefined;
  if (intent === 'train') return STEP_BLUEPRINTS.filter((step) => step.key === 'develop-init');

  const keys =
    answers.coverage === 'pick' && Array.isArray(answers.steps) ? answers.steps : intent ? SHOOT_STEPS : [];
  return STEP_BLUEPRINTS.filter((step) => keys.includes(step.key));
}

/**
 * Variable questions the chosen steps imply — the only things a default cannot
 * stand in for. One folder covers a whole shoot: the offload writes into it and
 * every later step reads it.
 */
function varQuestions(steps: StepBlueprint[], training: boolean): TextQuestion[] {
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
  if (needed.has('shoot')) {
    questions.push(
      training
        ? {
            kind: 'text',
            id: 'vars.shoot',
            label: 'Folder of photographs you have already edited',
            hint: 'Your look is learned from the edits in it',
            default: 'D:/Shoots/my-catalog',
          }
        : {
            kind: 'text',
            id: 'vars.shoot',
            label: 'Shoot folder',
            hint: 'Where the photographs are (or where the offload will put them)',
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
      // question for you, and an empty Artist tag written over a shoot is worse
      // than an obviously-wrong one waiting to be edited.
      default: 'Your Name',
    });
  }
  return questions;
}

/** Every question the current answers imply, in the order they are asked. */
export function wizardQuestions(answers: Answers, _context: CatalogContext = DEFAULT_CONTEXT): Question[] {
  const questions: Question[] = [intentQuestion()];

  const intent = typeof answers.intent === 'string' ? answers.intent : undefined;
  if (intent === undefined) return questions;

  if (intent !== 'train') {
    questions.push(coverageQuestion());
    if (answers.coverage === undefined) return questions;
    if (answers.coverage === 'pick') {
      questions.push(stepsQuestion());
      if (!Array.isArray(answers.steps)) return questions;
    }
  }

  questions.push(...varQuestions(selectedSteps(answers), intent === 'train'));
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
  const answers: Answers = { intent: presetId, ...overrides };
  let guard = 0;
  for (;;) {
    const question = nextQuestion(answers, context);
    if (!question) return answers;
    answers[question.id] = defaultOf(question);
    if (++guard > 100) throw new Error('pipeline init: question list did not converge');
  }
}

function draftVars(answers: Answers, steps: StepBlueprint[]): DraftVar[] {
  const needed = new Set(steps.flatMap((step) => step.vars));
  const value = (id: string, fallback = ''): string => {
    const raw = answers[id];
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : fallback;
  };

  const vars: DraftVar[] = [];
  if (needed.has('card')) vars.push({ name: 'card', value: value('vars.card') });
  if (needed.has('shoot')) vars.push({ name: 'shoot', value: value('vars.shoot') });
  if (needed.has('studio')) vars.push({ name: 'studio', value: value('vars.studio') });
  return vars;
}

/** Answers → the pipeline file, still unrendered. */
export function buildDraft(answers: Answers, context: CatalogContext = DEFAULT_CONTEXT): PipelineDraft {
  const steps = selectedSteps(answers);
  if (steps.length === 0) throw new Error('pipeline init: a pipeline needs at least one step');

  const intent = typeof answers.intent === 'string' ? answers.intent : PRESETS[0]!.id;
  const name =
    typeof answers.name === 'string' && answers.name.trim().length > 0
      ? answers.name.trim()
      : (findPreset(intent)?.name ?? 'my-pipeline');

  return {
    name,
    vars: draftVars(answers, steps),
    // No `defaults:` block: concurrency is per-machine and every command already
    // picks one. The header says where to add it when a run needs a different one.
    defaults: {} as Record<string, PipelineValue>,
    steps: steps.map((step) => step.build(context)),
  };
}

/** The comment block written above a generated file. */
export function draftHeader(fileName: string): string[] {
  return [
    'Scaffolding from `shoots pipeline init`. Every step runs on its own defaults;',
    'the commented lines under each one are the flags worth reaching for first.',
    '',
    `  shoots pipeline ${fileName} --dry-run   # print the command lines, run nothing`,
    `  shoots pipeline ${fileName}             # run it`,
    `  shoots pipeline ${fileName} --var shoot=D:/Shoots/next-one`,
    '',
    'A `defaults:` block above the steps applies a flag to every step that takes',
    'it — `concurrency: 8`, for one.',
  ];
}

export { STEP_BLUEPRINTS, PRESETS, findBlueprint, findPreset };
export type { CatalogContext, StepBlueprint };
