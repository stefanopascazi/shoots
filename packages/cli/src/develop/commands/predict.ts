/**
 * `develop predict` — apply a develop profile to a new develop-export dataset.
 *
 * Emits predicted crs develop vectors as JSON, and optionally writes a
 * Lightroom-readable `.xmp` sidecar per image (a non-destructive starting point).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { assertApplicable, predictOne, resolveTreatment } from '../predict.js';
import { assertCanEmit, DEFAULT_EDITOR, resolveAdapter } from '../adapters/registry.js';
import { loadDataset } from '../dataset/load.js';
import type { Treatment } from '../develop/schema.js';
import type { DevelopProfile } from '../types.js';

export interface PredictArgs {
  data: string;
  profile: string;
  treatment: string;
  /** Which editor's format to write the prediction in. */
  editor?: string;
  out?: string;
  xmp?: string;
}

export async function runPredict(args: PredictArgs): Promise<void> {
  const dataset = await loadDataset(args.data);
  const profile = JSON.parse(await readFile(args.profile, 'utf8')) as DevelopProfile;
  assertApplicable(profile, dataset.model, dataset.dim, dataset.colorDim);

  const requested = args.treatment as Treatment | 'auto';
  if (!['auto', 'color', 'bw'].includes(requested)) {
    throw new Error(`invalid --treatment '${args.treatment}' (use auto | color | bw)`);
  }

  const predictions = dataset.results
    .filter((r) => r.embedding?.length && r.features?.length)
    .map((r) => predictOne(profile, r, resolveTreatment(profile, r, requested)));

  if (args.xmp) {
    const adapter = resolveAdapter(args.editor ?? DEFAULT_EDITOR);
    assertCanEmit(adapter);
    await mkdir(args.xmp, { recursive: true });
    let replaced = 0;
    for (const p of predictions) {
      const target = adapter.sidecarPathFor!(p.file, args.xmp);
      if (existsSync(target)) replaced++;
      await adapter.writeEdit!({ develop: p.develop, treatment: p.treatment }, target);
    }
    process.stderr.write(`Wrote ${predictions.length} ${adapter.id} sidecars to ${args.xmp}\n`);
    // The sidecar is named after the image, so a second run with a different
    // --treatment lands on the same files. Say so: the colour set silently
    // becoming the B&W set is a surprising way to lose work.
    if (replaced > 0) {
      process.stderr.write(`  (${replaced} replaced sidecars already in that directory — use a separate --xmp dir per treatment)\n`);
    }
  }

  const payload = { command: 'develop-predict' as const, profile: profile.name, count: predictions.length, predictions };
  if (args.out) {
    await writeFile(args.out, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    process.stderr.write(`Wrote ${predictions.length} predictions to ${args.out}\n`);
  } else {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  }
}
