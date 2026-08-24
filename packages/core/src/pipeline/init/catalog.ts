/**
 * What `pipeline init` can put in a file: the steps, and what each one needs
 * from the person running it.
 *
 * The wizard writes *scaffolding*, not a finished configuration. That is the
 * rule this module is built around: a step carries the arguments only its author
 * can supply — the folder, the artist name — and nothing else, because every
 * command already has defaults it was designed around and repeating them in the
 * file would freeze today's values into every pipeline ever generated. What a
 * step could take instead becomes a commented hint under it, so the next flag is
 * one edit away rather than one documentation search away.
 *
 * The two exceptions are flags the file cannot run without (`import --dest`,
 * `rename --pattern`) and the marks that make rate and cull one pass instead of
 * two unrelated reports.
 *
 * Choice lists that mirror something the CLI owns (rating profiles, editor ids)
 * are injected as {@link CatalogContext} rather than duplicated here, so a hint
 * cannot name a profile that does not exist.
 */
import type { DraftStep } from './draft.js';

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
  /** The shoots command it runs, for the file and for the wizard's summaries. */
  run: string;
  /** Variables this step needs the author to fill in. */
  vars: string[];
  build(context: CatalogContext): DraftStep;
}

export const DEFAULT_RENAME_PATTERN = '{date}_{time}_{camera}_{seq:4}.{ext}';

/** `a · b · c` — how the commented hints list alternatives. */
const alternatives = (...items: string[]): string => `also: ${items.join(' · ')}`;

export const STEP_BLUEPRINTS: StepBlueprint[] = [
  {
    key: 'import',
    run: 'import',
    id: 'offload',
    label: 'import — offload the card',
    hint: 'Copy into the shoot folder, checksum-verified',
    vars: ['card', 'shoot'],
    build: () => ({
      comment: 'Card to shoot folder. Every copy is checksum-verified before it counts.',
      id: 'offload',
      run: 'import',
      args: ['${card}'],
      with: { dest: '${shoot}' }, // --dest is required; everything else defaults
      notes: [alternatives('move: true (delete each verified original)', 'rename: true', 'flat: true'),
        'dir: "{yyyy}/{yyyy-MM-dd}" — the subfolder template under dest',
      ],
    }),
  },
  {
    key: 'rename',
    run: 'rename',
    id: 'name-frames',
    label: 'rename — apply a filename template',
    hint: 'EXIF-driven names, in place',
    vars: ['shoot'],
    build: () => ({
      id: 'name-frames',
      run: 'rename',
      args: ['${shoot}'],
      with: { pattern: DEFAULT_RENAME_PATTERN }, // required, and the one thing worth editing
      notes: ['tokens: {date} {time} {camera} {lens} {seq:4} {ext}', alternatives('recursive: true')],
    }),
  },
  {
    key: 'exif',
    run: 'exif',
    id: 'studio-tags',
    label: 'exif — write your authorship tags',
    hint: 'Artist, copyright, keywords',
    vars: ['shoot', 'studio'],
    build: () => ({
      id: 'studio-tags',
      run: 'exif',
      args: ['${shoot}'],
      with: { 'set-artist': '${studio}' },
      notes: [
        alternatives('set-copyright: "© ${studio}. All rights reserved."', 'set-keywords: [wedding, smith]'),
      ],
    }),
  },
  {
    key: 'rate',
    run: 'rate',
    id: 'rating',
    label: 'rate — score every frame 0-5',
    hint: 'Local model, nothing leaves the machine',
    vars: ['shoot'],
    build: (context) => ({
      comment: 'rate and cull both write marks, so they stack instead of overwriting each other.',
      id: 'rating',
      run: 'rate',
      args: ['${shoot}'],
      with: { mark: true },
      notes: [alternatives(`profile: ${context.profiles.slice(0, 4).join(' | ')}`, 'write-xmp: true')],
    }),
  },
  {
    key: 'cull',
    run: 'cull',
    id: 'focus-check',
    label: 'cull — flag the out-of-focus frames',
    hint: 'Laplacian sharpness with shallow-depth-of-field rescue',
    vars: ['shoot'],
    build: (context) => ({
      id: 'focus-check',
      run: 'cull',
      args: ['${shoot}'],
      with: { mark: true },
      notes: [
        alternatives(
          'threshold: 100 (lower is more forgiving)',
          `mark-label: ${context.labels.slice(0, 3).join(' | ')}`,
          'dest: D:/rejects (move them instead of marking)',
        ),
      ],
    }),
  },
  {
    key: 'triage-apply',
    run: 'triage apply',
    id: 'apply-marks',
    label: 'triage apply — write the marks into sidecars',
    hint: 'Only needed when no develop step follows',
    vars: ['shoot'],
    build: (context) => ({
      id: 'apply-marks',
      run: 'triage apply',
      args: ['${shoot}'],
      with: {},
      notes: [alternatives(`editor: ${context.editors.join(' | ')}`, 'redo: true')],
    }),
  },
  {
    key: 'develop-edit',
    run: 'develop edit',
    id: 'develop',
    label: 'develop edit — apply your learned look',
    hint: 'Needs a profile from `shoots develop init`',
    vars: ['shoot'],
    build: () => ({
      comment: 'Pending cull/rate marks reach the sidecars here (default on).',
      id: 'develop',
      run: 'develop edit',
      args: ['${shoot}'],
      with: {},
      notes: [alternatives('treatment: color | bw', 'profile: my-style.json', 'force: true')],
    }),
  },
  {
    key: 'develop-init',
    run: 'develop init',
    id: 'learn-style',
    label: 'develop init — learn your look',
    hint: 'Export an edited catalog and fit the profile, in one step',
    vars: ['shoot'],
    build: (context) => ({
      comment: 'Reads the edits you already made and fits a profile under ~/.shoots/develop.',
      id: 'learn-style',
      run: 'develop init',
      args: ['${shoot}'],
      with: {},
      notes: [
        alternatives('name: my-style', `editor: ${context.editors.join(' | ')}`, 'boldness: 1', 'anchor-gain: 2'),
        'review: true opens a page to set the corrections by eye before writing the profile',
      ],
    }),
  },
];

/**
 * The two things somebody opens this command to do.
 *
 * Not a menu of pipelines: the first question is what you are doing today, and
 * the steps follow from it. `train` is a single command — `develop init` already
 * is the export-and-fit pipeline — which is why it asks for nothing but a path.
 */
export interface Preset {
  id: string;
  label: string;
  hint: string;
  /** Pipeline name written into the file. */
  name: string;
  steps: string[];
}

export const PRESETS: Preset[] = [
  {
    id: 'shoot',
    label: 'Work on a shoot',
    hint: 'tag, rate, cull and develop a folder of photographs',
    name: 'shoot-pass',
    steps: ['exif', 'rate', 'cull', 'develop-edit'],
  },
  {
    id: 'train',
    label: 'Train your develop profile',
    hint: 'learn your look from a catalog you have already edited',
    name: 'develop-training',
    steps: ['develop-init'],
  },
];

export const findBlueprint = (key: string): StepBlueprint | undefined =>
  STEP_BLUEPRINTS.find((step) => step.key === key);

export const findPreset = (id: string): Preset | undefined => PRESETS.find((preset) => preset.id === id);
