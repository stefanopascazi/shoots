/**
 * What `pipeline init` knows how to build: the steps it can offer, the questions
 * each one needs answered, and the presets that pre-tick a sensible set.
 *
 * This is deliberately a curated subset, not a reflection of the whole CLI: the
 * wizard exists for the photographer who does not write YAML, and "here are the
 * six steps of an ingest" helps them where "here are 16 commands and 90 flags"
 * does not. The generated file is ordinary pipeline YAML, so anything the wizard
 * does not offer is still one hand-written step away.
 *
 * Choice lists that mirror something the CLI owns (rating profiles, editor ids,
 * triage labels) are injected as {@link CatalogContext} rather than duplicated
 * here, so this module cannot drift from what those commands actually accept.
 */
import type { PipelineValue } from '../PipelineConfig.js';
import type { DraftStep } from './draft.js';
import type { Answers, Question } from './questions.js';

export interface CatalogContext {
  /** `--profile` values `rate` accepts (built-in + learned). */
  profiles: string[];
  /** `--editor` values the develop adapters register. */
  editors: string[];
  /** Semantic triage labels `cull --mark-label` accepts. */
  labels: string[];
}

export interface StepBlueprint {
  /** Key in the `steps` multiselect. */
  key: string;
  /** Step id written into the file. */
  id: string;
  label: string;
  hint: string;
  /** Variables this step needs declared. */
  vars: string[];
  /** True when the command takes `--concurrency` (drives the `defaults` block). */
  concurrent?: boolean;
  questions(context: CatalogContext): Question[];
  build(answers: Answers, context: CatalogContext): DraftStep;
}

const text = (answers: Answers, id: string, fallback = ''): string => {
  const value = answers[id];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
};

const bool = (answers: Answers, id: string, fallback: boolean): boolean => {
  const value = answers[id];
  return typeof value === 'boolean' ? value : fallback;
};

/** `"100"` becomes the number 100, so a numeric flag lands in the file as one. */
const numeric = (value: string): PipelineValue => {
  const n = Number(value);
  return Number.isFinite(n) && value.trim().length > 0 ? n : value;
};

/** `"wedding, smith"` becomes a list; empty input means no list at all. */
const list = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

const choices = (values: string[]): Array<{ value: string; label: string }> =>
  values.map((value) => ({ value, label: value }));

export const DEFAULT_RENAME_PATTERN = '{date}_{time}_{camera}_{seq:4}.{ext}';

export const STEP_BLUEPRINTS: StepBlueprint[] = [
  {
    key: 'import',
    id: 'offload',
    label: 'import — offload the card',
    hint: 'Copy into the shoot folder, checksum-verified',
    vars: ['card', 'raw'],
    concurrent: true,
    questions: () => [
      {
        kind: 'confirm',
        id: 'import.move',
        label: 'Delete each source file once its copy is verified?',
        hint: 'No = copy only, the card is left untouched',
        default: false,
      },
    ],
    build: (answers) => ({
      comment: 'Card to shoot folder. Every copy is checksum-verified before it counts.',
      id: 'offload',
      run: 'import',
      args: ['${card}'],
      with: { dest: '${raw}', move: bool(answers, 'import.move', false) },
    }),
  },
  {
    key: 'rename',
    id: 'name-frames',
    label: 'rename — apply a filename template',
    hint: 'EXIF-driven names, in place',
    vars: ['raw'],
    questions: () => [
      {
        kind: 'text',
        id: 'rename.pattern',
        label: 'Filename template',
        hint: 'Tokens: {date} {time} {camera} {lens} {seq:4} {ext}',
        default: DEFAULT_RENAME_PATTERN,
      },
    ],
    build: (answers) => ({
      id: 'name-frames',
      run: 'rename',
      args: ['${raw}'],
      with: { pattern: text(answers, 'rename.pattern', DEFAULT_RENAME_PATTERN), recursive: true },
    }),
  },
  {
    key: 'exif',
    id: 'studio-tags',
    label: 'exif — write your authorship tags',
    hint: 'Artist, copyright, keywords',
    vars: ['raw', 'studio'],
    questions: () => [
      {
        kind: 'text',
        id: 'exif.copyright',
        label: 'Copyright notice',
        hint: '${studio} expands to the name you gave above',
        default: '© ${studio}. All rights reserved.',
        optional: true,
      },
      {
        kind: 'text',
        id: 'exif.keywords',
        label: 'Keywords',
        hint: 'Comma-separated; leave empty for none',
        default: '',
        optional: true,
      },
    ],
    build: (answers) => {
      const options: Record<string, PipelineValue> = { 'set-artist': '${studio}' };
      const copyright = text(answers, 'exif.copyright');
      if (copyright) options['set-copyright'] = copyright;
      const keywords = list(text(answers, 'exif.keywords'));
      if (keywords.length > 0) options['set-keywords'] = keywords;
      return { id: 'studio-tags', run: 'exif', args: ['${raw}'], with: options };
    },
  },
  {
    key: 'rate',
    id: 'rating',
    label: 'rate — score every frame 0-5',
    hint: 'Local model, nothing leaves the machine',
    vars: ['raw'],
    concurrent: true,
    questions: (context) => [
      {
        kind: 'select',
        id: 'rate.profile',
        label: 'Rating profile',
        hint: 'What the model should reward',
        choices: choices(context.profiles),
        default: context.profiles[0] ?? 'generic',
      },
      {
        kind: 'confirm',
        id: 'rate.mark',
        label: 'Record ratings as triage marks?',
        hint: 'Yes = stack with cull and reach the sidecars later; No = write sidecars now',
        default: true,
      },
    ],
    build: (answers, context) => ({
      comment: 'rate and cull both write marks, so they stack instead of overwriting each other.',
      id: 'rating',
      run: 'rate',
      args: ['${raw}'],
      with: {
        profile: text(answers, 'rate.profile', context.profiles[0] ?? 'generic'),
        mark: bool(answers, 'rate.mark', true),
      },
    }),
  },
  {
    key: 'cull',
    id: 'focus-check',
    label: 'cull — flag the out-of-focus frames',
    hint: 'Laplacian sharpness with shallow-depth-of-field rescue',
    vars: ['raw'],
    concurrent: true,
    questions: (context) => [
      {
        kind: 'text',
        id: 'cull.threshold',
        label: 'Blur threshold',
        hint: 'Laplacian variance; lower is more forgiving. Tune per camera',
        default: '100',
      },
      {
        kind: 'select',
        id: 'cull.label',
        label: 'Label for the rejects',
        choices: choices(context.labels),
        default: context.labels.includes('reject') ? 'reject' : (context.labels[0] ?? 'reject'),
      },
    ],
    build: (answers, context) => ({
      id: 'focus-check',
      run: 'cull',
      args: ['${raw}'],
      with: {
        mark: true,
        'mark-label': text(answers, 'cull.label', context.labels[0] ?? 'reject'),
        threshold: numeric(text(answers, 'cull.threshold', '100')),
      },
    }),
  },
  {
    key: 'triage-apply',
    id: 'apply-marks',
    label: 'triage apply — write the marks into sidecars',
    hint: 'Only needed when no develop step follows',
    vars: ['raw'],
    questions: (context) => [
      {
        kind: 'select',
        id: 'triage.editor',
        label: 'Whose label vocabulary to write in',
        choices: choices(context.editors),
        default: context.editors[0] ?? 'acr',
      },
    ],
    build: (answers, context) => ({
      id: 'apply-marks',
      run: 'triage apply',
      args: ['${raw}'],
      with: { editor: text(answers, 'triage.editor', context.editors[0] ?? 'acr') },
    }),
  },
  {
    key: 'develop-edit',
    id: 'develop',
    label: 'develop edit — apply your learned look',
    hint: 'Needs a profile from `shoots develop init`',
    vars: ['raw'],
    concurrent: true,
    questions: () => [
      {
        kind: 'select',
        id: 'develop.treatment',
        label: 'Treatment',
        choices: [
          { value: 'auto', label: 'auto', hint: 'let the profile decide per frame' },
          { value: 'color', label: 'color' },
          { value: 'bw', label: 'bw' },
        ],
        default: 'auto',
      },
    ],
    build: (answers) => ({
      comment: 'Pending cull/rate marks reach the sidecars here (default on).',
      id: 'develop',
      run: 'develop edit',
      args: ['${raw}'],
      with: { treatment: text(answers, 'develop.treatment', 'auto') },
    }),
  },
  {
    key: 'develop-export',
    id: 'export-dataset',
    label: 'develop export — build a training dataset',
    hint: 'Reads the edits you already made',
    vars: ['raw', 'dataset'],
    concurrent: true,
    questions: () => [
      {
        kind: 'confirm',
        id: 'develop.editedOnly',
        label: 'Export only the frames that carry an edit?',
        hint: 'Yes for a training set: it skips the expensive work on everything else',
        default: true,
      },
    ],
    build: (answers) => ({
      id: 'export-dataset',
      run: 'develop export',
      args: ['${raw}'],
      with: { out: '${dataset}', 'edited-only': bool(answers, 'develop.editedOnly', true) },
    }),
  },
  {
    key: 'develop-train',
    id: 'train-profile',
    label: 'develop train — fit the profile',
    hint: 'Turns the dataset into your look',
    vars: ['dataset', 'profileFile'],
    questions: () => [
      {
        kind: 'text',
        id: 'develop.profileName',
        label: 'Profile name',
        default: 'my-style',
      },
    ],
    build: (answers) => ({
      id: 'train-profile',
      run: 'develop train',
      args: [],
      with: {
        data: '${dataset}',
        name: text(answers, 'develop.profileName', 'my-style'),
        out: '${profileFile}',
      },
    }),
  },
];

export interface Preset {
  id: string;
  label: string;
  hint: string;
  /** Default pipeline name written into the file. */
  name: string;
  steps: string[];
}

export const PRESETS: Preset[] = [
  {
    id: 'ingest',
    label: 'Full ingest',
    hint: 'card, named, tagged, rated, culled, developed',
    name: 'ingest',
    steps: ['import', 'rename', 'exif', 'rate', 'cull', 'develop-edit'],
  },
  {
    id: 'cull-rate',
    label: 'Cull & rate',
    hint: 'photographs already on disk: rate, cull, write the marks out',
    name: 'cull-and-rate',
    steps: ['rate', 'cull', 'triage-apply'],
  },
  {
    id: 'develop-train',
    label: 'Train a develop profile',
    hint: 'export an edited folder, then fit the profile',
    name: 'develop-training',
    steps: ['develop-export', 'develop-train'],
  },
  {
    id: 'custom',
    label: 'Start from nothing',
    hint: 'pick every step yourself',
    name: 'my-pipeline',
    steps: [],
  },
];

export const findBlueprint = (key: string): StepBlueprint | undefined =>
  STEP_BLUEPRINTS.find((step) => step.key === key);

export const findPreset = (id: string): Preset | undefined => PRESETS.find((preset) => preset.id === id);
