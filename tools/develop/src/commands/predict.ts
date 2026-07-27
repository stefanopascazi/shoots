/**
 * `develop predict` — apply a develop profile to a new develop-export dataset.
 *
 * Emits predicted crs develop vectors as JSON, and optionally writes a
 * Lightroom-readable `.xmp` sidecar per image (a non-destructive starting point).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { assertApplicable, predictOne, resolveTreatment } from '../predict.js';
import { buildXmpSidecar } from '../xmp.js';
import { loadDataset } from '../dataset/load.js';
import type { Treatment } from '../develop/schema.js';
import type { DevelopProfile } from '../types.js';

export interface PredictArgs {
  data: string;
  profile: string;
  treatment: string;
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
    await mkdir(args.xmp, { recursive: true });
    for (const p of predictions) {
      const base = path.parse(p.file).name;
      await writeFile(path.join(args.xmp, `${base}.xmp`), buildXmpSidecar(p.develop), 'utf8');
    }
    process.stderr.write(`Wrote ${predictions.length} XMP sidecars to ${args.xmp}\n`);
  }

  const payload = { command: 'develop-predict' as const, profile: profile.name, count: predictions.length, predictions };
  if (args.out) {
    await writeFile(args.out, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    process.stderr.write(`Wrote ${predictions.length} predictions to ${args.out}\n`);
  } else {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  }
}
