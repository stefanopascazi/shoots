/**
 * `develop predict` — apply a develop profile to a new develop-export dataset.
 *
 * Emits predicted crs develop vectors as JSON, and optionally writes a
 * Lightroom-readable `.xmp` sidecar per image (a non-destructive starting point).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { assertApplicable, predictOne } from '../predict.js';
import { buildXmpSidecar } from '../xmp.js';
import type { DevelopDataset, DevelopProfile } from '../types.js';

export interface PredictArgs {
  data: string;
  profile: string;
  out?: string;
  xmp?: string;
}

export async function runPredict(args: PredictArgs): Promise<void> {
  const dataset = JSON.parse(await readFile(args.data, 'utf8')) as DevelopDataset;
  if (dataset.command !== 'develop-export') {
    throw new Error(`'${args.data}' is not a develop-export dataset (command: ${String(dataset.command)})`);
  }
  const profile = JSON.parse(await readFile(args.profile, 'utf8')) as DevelopProfile;
  assertApplicable(profile, dataset.model, dataset.dim, dataset.colorDim);

  const predictions = dataset.results
    .filter((r) => r.embedding?.length && r.features?.length)
    .map((r) => predictOne(profile, r));

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
