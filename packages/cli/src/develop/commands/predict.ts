/**
 * `develop predict` — apply a develop profile to a new develop-export dataset.
 *
 * Emits predicted crs develop vectors as JSON, and optionally writes a
 * Lightroom-readable `.xmp` sidecar per image (a non-destructive starting point).
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
import { ensureExiftoolReady } from '../../tools.js';
import type { DevelopProfile } from '../types.js';

export interface PredictArgs {
  data: string;
  profile: string;
  treatment: string;
  /** Which editor's format to write the prediction in. */
  editor?: string;
  /** Base rendering to assume and to write out, overriding the catalog's own. */
  cameraProfile?: string;
  out?: string;
  xmp?: string;
  /**
   * Write each sidecar next to its own photograph instead of flat into {@link
   * xmp}.
   *
   * A catalog is a tree — `<shoot>/2026-08-02/`, `<shoot>/2026-08-03/` — and a
   * sidecar only works where its RAW is, so `develop edit` needs this. Flattening
   * also collides: two days both holding `IMG_0001.CR3` produce one
   * `IMG_0001.xmp`, and the second silently wins.
   *
   * `develop predict --xmp <dir>` keeps the flat behaviour on purpose: there the
   * directory is a scratch space you compare treatments in, not a catalog.
   */
  xmpBeside?: boolean;
  /**
   * Merge pending `cull` / `rate` marks into the sidecars just written
   * (default). This is the last stop in the shoot: cull → rate → develop, and
   * the marks have no other way out.
   */
  applyMarks?: boolean;
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

  const predictions = usable.map((r) =>
    predictOne(
      profile,
      r,
      resolveTreatment(profile, r, requested),
      contextFor(context, r.file, base.get(r.file)!),
      args.cameraProfile,
    ),
  );

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

  if (args.xmp) {
    const adapter = resolveAdapter(args.editor ?? DEFAULT_EDITOR);
    assertCanEmit(adapter);
    if (!args.xmpBeside) await mkdir(args.xmp, { recursive: true });
    const sidecarFor = (file: string): string =>
      adapter.sidecarPathFor!(file, args.xmpBeside ? path.dirname(path.resolve(file)) : args.xmp!);
    const files = predictions.map((p) => p.file);
    let replaced = 0;
    for (const p of predictions) if (existsSync(sidecarFor(p.file))) replaced++;

    // Both the preserve-and-remerge write and the mark application go through
    // exiftool. Neither runs on a clean directory with no marks, so only pay the
    // provisioning when one of them is actually about to happen — but pay it
    // before the first write, not 300 sidecars in.
    const pending = args.applyMarks === false ? 0 : await countPending(files);
    if ((replaced > 0 || pending > 0) && !(await ensureExiftoolReady(makeIo({})))) return;

    for (const p of predictions) {
      await adapter.writeEdit!({ develop: p.develop, treatment: p.treatment, render: p.render }, sidecarFor(p.file));
    }
    process.stderr.write(
      args.xmpBeside
        ? `Wrote ${predictions.length} ${adapter.id} sidecars next to the photographs, under ${args.xmp}\n`
        : `Wrote ${predictions.length} ${adapter.id} sidecars to ${args.xmp}\n`,
    );
    // The sidecar is named after the image, so a second run with a different
    // --treatment lands on the same files. Say so: the colour set silently
    // becoming the B&W set is a surprising way to lose work.
    if (replaced > 0) {
      process.stderr.write(
        args.xmpBeside
          ? `  (${replaced} sidecars already existed and were rewritten — their ratings, labels and keywords were preserved)\n`
          : `  (${replaced} replaced sidecars already in that directory — use a separate --xmp dir per treatment)\n`,
      );
    }

    // The sidecars now exist and carry crs. Anything `cull` or `rate` decided
    // about these frames has been waiting for exactly this moment: merge it in,
    // in the editor's own label vocabulary, and consume the marks.
    if (args.applyMarks !== false) {
      const result = await applyMarks(adapter, files, sidecarFor);
      if (result.applied.length > 0) {
        process.stderr.write(`Applied ${result.applied.length} triage mark(s) from cull/rate into those sidecars\n`);
      }
      for (const e of result.errors) process.stderr.write(`warn: ${e.file}: could not apply marks: ${e.error}\n`);
    }
  }

  // Stamped, because `feedback` has to know whether this prediction predates the
  // photographs entering the training set — that ordering is the whole of what
  // makes a later comparison held-out or worthless (see journal.isInSample).
  const payload = {
    command: 'develop-predict' as const,
    at: new Date().toISOString(),
    profile: profile.name,
    count: predictions.length,
    predictions,
  };
  if (args.out) {
    await writeFile(args.out, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    process.stderr.write(`Wrote ${predictions.length} predictions to ${args.out}\n`);
  } else {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  }
}
