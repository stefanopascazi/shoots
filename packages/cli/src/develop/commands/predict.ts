/**
 * `develop predict` — apply a develop profile to a new develop-export dataset.
 *
 * Emits predicted crs develop vectors as JSON, and optionally writes one
 * editor-readable sidecar per image (a non-destructive starting point) through
 * the adapter, which decides both the format and the filename.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { assertApplicable, predictOne, resolveTreatment } from '../predict.js';
import { assertCanEmit, DEFAULT_EDITOR, resolveAdapter } from '../adapters/registry.js';
import { loadDataset } from '../dataset/load.js';
import { renderKey, type Treatment } from '../develop/schema.js';
import { buildSessionContext, contextFor, soloSessionCount } from '../develop/session.js';
import { baseFeatures } from '../develop/assemble.js';
import { applyMarks, countPending } from '../../triage/apply.js';
import { makeIo } from '../../io.js';
import type { DevelopProfile, ParamState } from '../types.js';
import { countStates, stateMap, summariseStates } from '../develop/paramState.js';
import { applyStyle, loadStyle } from '../style/style.js';
import { applyIntents, resolveIntents, type IntentDef } from '../intents/intents.js';
import { frameHistograms } from '../intents/frame.js';
import { readVision } from '../../vision/read.js';
import type { VisionRecord, VisionRegion } from '../../vision/record.js';
import { loadIntentThresholds } from './intents.js';
import type { IntentThresholds } from '../intents/calibrate.js';
import { resolveRawDeveloper } from '../../rawDeveloper.js';
import type { Prediction } from '../predict.js';
import type { AsShotMeta } from '../develop/schema.js';

export interface PredictArgs {
  data: string;
  profile: string;
  treatment: string;
  /** Which editor's format to write the prediction in. */
  editor?: string;
  /** Base rendering to assume and to write out, overriding the catalog's own. */
  cameraProfile?: string;
  out?: string;
  /**
   * Directory to write one editor-readable sidecar per image into.
   *
   * Not `xmp`: the extension is the adapter's business — `.xmp` for ACR,
   * `.rrdata` for RapidRAW — and naming the field after one of them is how the
   * ACR assumption used to spread through code that had no business knowing.
   */
  sidecars?: string;
  /**
   * Write each sidecar next to its own photograph instead of flat into {@link
   * sidecars}.
   *
   * A catalog is a tree — `<shoot>/2026-08-02/`, `<shoot>/2026-08-03/` — and a
   * sidecar only works where its RAW is, so `develop edit` needs this. Flattening
   * also collides: two days both holding `IMG_0001.CR3` produce one
   * `IMG_0001.xmp`, and the second silently wins.
   *
   * `develop predict --sidecars <dir>` keeps the flat behaviour on purpose: there
   * the directory is a scratch space you compare treatments in, not a catalog.
   */
  besideSource?: boolean;
  /**
   * Merge pending `cull` / `rate` marks into the sidecars just written
   * (default). This is the last stop in the shoot: cull → rate → develop, and
   * the marks have no other way out.
   */
  applyMarks?: boolean;
  /** A detail profile (name or path) applied on top of the general prediction. */
  style?: string;
  /** 0..1: how much of the style to apply (default 1). */
  styleStrength?: number;
  /** Global develop intents (ids from intents/intents.ts), met after profile and style. */
  intents?: string[];
  /** 0..1: how far the intents move the prediction (default: the saved one, else 1). */
  intentStrength?: number;
}

export async function runPredict(args: PredictArgs): Promise<void> {
  const dataset = await loadDataset(args.data);
  const profile = JSON.parse(await readFile(args.profile, 'utf8')) as DevelopProfile;
  assertApplicable(profile, dataset);

  // Offsets from `develop calibrate` ride on top of every prediction, so say so
  // rather than leaving a silently different number to be discovered.
  const calibration = profile.calibration;
  if (calibration) {
    const n = Object.values(calibration.offsets).reduce((a, o) => a + Object.keys(o ?? {}).length, 0);
    process.stderr.write(`Carrying ${n} calibration offset(s) from your own corrections (\`develop calibrate --reset\` drops them)\n`);
    if (calibration.profileTrainedAt !== profile.trainedAt) {
      process.stderr.write(
        'warn: the calibration was measured against an older training of this profile — its offsets describe a model ' +
          'that no longer exists; re-run `shoots develop calibrate`\n',
      );
    }
  }

  const requested = args.treatment as Treatment | 'auto';
  if (!['auto', 'color', 'bw'].includes(requested)) {
    throw new Error(`invalid --treatment '${args.treatment}' (use auto | color | bw)`);
  }

  // Session context is transductive by design: a frame's prediction depends on
  // what else is in its folder (see develop/session.ts). Built from every record
  // in the set, including any that carry no edit.
  const usable = dataset.results.filter((r) => r.embedding?.length && r.features?.length);
  const base = new Map(usable.map((r) => [r.file, baseFeatures(r.embedding, r.features, r.asShot)]));
  const context = buildSessionContext(usable.map((r) => ({ file: r.file, features: base.get(r.file)! })));
  const solo = soloSessionCount(context, usable.map((r) => r.file));
  if (solo > 0) {
    process.stderr.write(
      `warn: ${solo}/${usable.length} images sit alone in their folder — the model reads how far a frame departs ` +
        `from its shoot, and a lone frame departs from itself by nothing: only the per-shoot level will be predicted\n`,
    );
  }

  // Validated before any work: an unknown or contradictory intent is a typo, and
  // finding it after the predictions would waste the run.
  const intents = resolveIntents(args.intents ?? []);
  const style = args.style ? await loadStyle(args.style, profile, (m) => process.stderr.write(`${m}\n`)) : undefined;
  const strength = args.styleStrength ?? 1;
  if (!(strength >= 0 && strength <= 1)) throw new Error(`invalid --style-strength ${args.styleStrength} (use 0..1)`);
  const predictions = usable.map((r) => {
    const p = predictOne(
      profile,
      r,
      resolveTreatment(profile, r, requested),
      contextFor(context, r.file, base.get(r.file)!),
      args.cameraProfile,
    );
    return style ? applyStyle(p, style, strength) : p;
  });
  let adjusted = 0;
  if (intents.length) {
    const { thresholds, calibrated, strength: saved } = await loadIntentThresholds();
    const intentStrength = args.intentStrength ?? saved;
    if (!(intentStrength >= 0 && intentStrength <= 1)) throw new Error(`invalid --intent-strength ${args.intentStrength} (use 0..1)`);
    if (!calibrated) process.stderr.write('Intents use default thresholds — `shoots develop intents calibrate` measures yours\n');
    adjusted = await meetIntents(predictions, intents, new Map(usable.map((r) => [r.file, r.asShot])), thresholds, intentStrength);
  }

  // Which rendering the values are meant to sit on decides what every slider
  // means, and it is invisible in the numbers — so say it out loud rather than
  // let it be discovered in Lightroom.
  const renders = new Map<string, number>();
  for (const p of predictions) {
    const label = renderKey(p.render) ?? '(editor default)';
    renders.set(label, (renders.get(label) ?? 0) + 1);
  }
  for (const [label, count] of [...renders.entries()].sort((a, b) => b[1] - a[1])) {
    const render = predictions.find((p) => (renderKey(p.render) ?? '(editor default)') === label)?.render;
    const caveat = label === '(editor default)'
      ? ' — the profile records no rendering, so Lightroom will use its own default'
      : render?.look && !render.lookXml
        ? ` — base profile only: no Look element was captured for "${render.look}"`
        : '';
    process.stderr.write(`Rendering: ${label} (${count} images)${caveat}\n`);
  }

  if (args.sidecars) {
    const adapter = resolveAdapter(args.editor ?? DEFAULT_EDITOR);
    assertCanEmit(adapter);
    if (!args.besideSource) await mkdir(args.sidecars, { recursive: true });
    const sidecarFor = (file: string): string =>
      adapter.sidecarPathFor!(file, args.besideSource ? path.dirname(path.resolve(file)) : args.sidecars!);
    const files = predictions.map((p) => p.file);
    let replaced = 0;
    for (const p of predictions) if (existsSync(sidecarFor(p.file))) replaced++;

    // Whatever the adapter needs in order to write — for ACR that is exiftool,
    // which both the preserve-and-remerge write and the mark application go
    // through. Neither runs on a clean directory with no marks, so only pay for
    // it when one of them is actually about to happen, and pay before the first
    // write rather than 300 sidecars in.
    const pending = args.applyMarks === false ? 0 : await countPending(files, sidecarFor);
    if ((replaced > 0 || pending > 0) && adapter.ensureWritable && !(await adapter.ensureWritable(makeIo({})))) {
      return;
    }

    // The white balance a prediction states is an absolute Kelvin, which only
    // means something beside the temperature the camera recorded. An adapter
    // whose own WB control is relative to as-shot needs both.
    const asShotFor = new Map(usable.map((r) => [r.file, r.asShot]));
    for (const p of predictions) {
      await adapter.writeEdit!(
        { develop: p.develop, treatment: p.treatment, render: p.render, asShot: asShotFor.get(p.file) },
        sidecarFor(p.file),
      );
    }
    process.stderr.write(
      args.besideSource
        ? `Wrote ${predictions.length} ${adapter.id} sidecars next to the photographs, under ${args.sidecars}\n`
        : `Wrote ${predictions.length} ${adapter.id} sidecars to ${args.sidecars}\n`,
    );
    // The sidecar is named after the image, so a second run with a different
    // --treatment lands on the same files. Say so: the colour set silently
    // becoming the B&W set is a surprising way to lose work.
    if (replaced > 0) {
      process.stderr.write(
        args.besideSource
          ? `  (${replaced} sidecars already existed and were rewritten — their ratings, labels and keywords were preserved)\n`
          : `  (${replaced} replaced sidecars already in that directory — use a separate --sidecars dir per treatment)\n`,
      );
    }

    // The sidecars now exist and carry crs. Anything `cull` or `rate` decided
    // about these frames has been waiting for exactly this moment: merge it in,
    // in the editor's own label vocabulary, and consume the marks.
    if (args.applyMarks !== false) {
      const result = await applyMarks(adapter, files, sidecarFor);
      if (result.applied.length > 0) {
        process.stderr.write(`Applied ${result.applied.length} triage mark(s) from cull/rate into those sidecars\n`);
      } else {
        // Saying nothing here is how a sidecar with no label reads as a bug: the
        // photographer cannot tell "nothing was recorded" from "the labels were
        // dropped". Marks are opt-in, so the usual answer is the first one.
        process.stderr.write(
          'No triage marks pending for these files — labels and ratings come from ' +
            '`cull --mark` / `rate --mark` (`shoots triage list` shows what is waiting)\n',
        );
      }
      for (const e of result.errors) process.stderr.write(`warn: ${e.file}: could not apply marks: ${e.error}\n`);
    }
  }

  // Stamped, because `feedback` has to know whether this prediction predates the
  // photographs entering the training set — that ordering is the whole of what
  // makes a later comparison held-out or worthless (see journal.isInSample).
  // What the profile promised, alongside what it produced. A prediction that
  // does not say which of its sliders followed the photograph and which are the
  // photographer's own constant reads as a decision on every one of them.
  const parameters: Partial<Record<Treatment, Record<string, ParamState>>> = {};
  for (const treatment of new Set(predictions.map((p) => p.treatment))) {
    const branch = profile.branches[treatment];
    if (branch) parameters[treatment] = stateMap(branch);
  }
  for (const [treatment, states] of Object.entries(parameters)) {
    const branch = profile.branches[treatment as Treatment]!;
    process.stderr.write(
      `${treatment}: ${summariseStates(countStates(states), branch.negativeSkillParams?.length ?? 0)}\n`,
    );
  }

  const payload = {
    command: 'develop-predict' as const,
    at: new Date().toISOString(),
    profile: profile.name,
    ...(style ? { style: style.name, styleStrength: strength } : {}),
    ...(intents.length ? { intents: intents.map((i) => i.id), adjusted } : {}),
    count: predictions.length,
    /** Per branch, what each parameter did: predicted | leveled | constant. */
    parameters,
    predictions,
  };
  if (args.out) {
    await writeFile(args.out, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    process.stderr.write(`Wrote ${predictions.length} predictions to ${args.out}\n`);
  } else {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  }
}

/**
 * Meet the intents on every prediction, in place; returns how many frames moved.
 *
 * Each frame needs its RAW decoded for the histogram the intents are judged on,
 * so a few run at once. A frame that cannot be decoded keeps its prediction and
 * is reported, rather than failing the whole shoot.
 */
async function meetIntents(
  predictions: Prediction[],
  intents: readonly IntentDef[],
  asShot: Map<string, AsShotMeta>,
  thresholds: IntentThresholds,
  strength: number,
): Promise<number> {
  // Every frame needs the same decoder; without it the intents cannot be judged
  // at all, and silently skipping them would hand back a prediction that ignores
  // what was asked.
  if (!resolveRawDeveloper()) throw new Error('intents need the RAW developer to read each photograph — run `shoots setup`');
  process.stderr.write(`Meeting ${intents.length} intent(s): ${intents.map((i) => i.id).join(', ')}\n`);
  // Region intents need to know where the sky and the subject are.
  const needed = new Set(intents.flatMap((i) => i.regions ?? []));
  const vision: Map<string, VisionRecord> = needed.size
    ? await readVision(predictions.map((p) => p.file), (m) => process.stderr.write(`${m}\n`))
    : new Map();
  let adjusted = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < predictions.length) {
      const p = predictions[next++]!;
      try {
        const meta = asShot.get(p.file);
        if (!meta) throw new Error('no capture metadata in the dataset');
        const masks = Object.fromEntries(
          Object.entries(vision.get(p.file)?.regions ?? {}).filter(([region]) => needed.has(region as VisionRegion)),
        );
        const { frame, regions } = await frameHistograms(p.file, p.develop, meta, masks);
        const develop = applyIntents(p.develop, frame, intents, thresholds, strength, regions);
        if (develop !== p.develop) {
          p.develop = develop;
          adjusted++;
        }
      } catch (err) {
        process.stderr.write(`warn: ${p.file}: intents not applied — ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  process.stderr.write(`Intents moved ${adjusted}/${predictions.length} frame(s); the rest already met them\n`);
  return adjusted;
}
